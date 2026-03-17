const express = require('express');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const firebaseConfig = {
  projectId: 'userkeeper-727e1',
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

initializeApp({ credential: cert(firebaseConfig) });
const db = getFirestore();

const BOT_TOKEN = process.env.BOT_TOKEN;

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// ── WEBHOOK ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.sendStatus(200);

    const chatId = String(message.chat.id);
    const userId = String(message.from.id);
    const username = message.from.username || null;
    const firstName = message.from.first_name || '';
    const lastName = message.from.last_name || '';
    const text = message.text || '';

    if (text === '/start') {
      await db.collection('users').doc(userId).set({
        tgId: userId, tgUsername: username, chatId,
        name: firstName, last: lastName,
        botStarted: true, startedAt: new Date()
      }, { merge: true });

      await sendMessage(chatId,
        `👋 Привет, ${firstName}!\n\nДобро пожаловать в UserKeeper 🛰\n\nТеперь ты будешь получать SOS сигналы от своих контактов.\n\nОткрой приложение через кнопку меню ниже 👇`
      );
    }

    // Admin verification commands
    if (username === 'userkeeper') {
      if (text.startsWith('/verify_')) {
        const uid = text.replace('/verify_', '').trim();
        await db.collection('users').doc(uid).set({ verificationStatus: 'verified' }, { merge: true });
        await db.collection('verifications').doc(uid).set({ verificationStatus: 'verified', verifiedAt: new Date() }, { merge: true });
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists && userDoc.data().chatId) {
          await sendMessage(userDoc.data().chatId,
            `✅ Верификация пройдена!\n\nТвой статус подтверждён. Значок ✅ появится в приложении.\n\nСпасибо что помогаешь людям! 🙏`
          );
        }
        await sendMessage(chatId, `✅ Пользователь ${uid} верифицирован`);
      }

      if (text.startsWith('/reject_')) {
        const uid = text.replace('/reject_', '').trim();
        await db.collection('users').doc(uid).set({ verificationStatus: 'rejected' }, { merge: true });
        await db.collection('verifications').doc(uid).set({ verificationStatus: 'rejected', rejectedAt: new Date() }, { merge: true });
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists && userDoc.data().chatId) {
          await sendMessage(userDoc.data().chatId,
            `❌ Верификация отклонена\n\nК сожалению, документ не прошёл проверку. Если это ошибка — напиши @userkeeper`
          );
        }
        await sendMessage(chatId, `❌ Пользователь ${uid} отклонён`);
      }
    }

    if (message.location) {
      const { latitude, longitude } = message.location;
      await db.collection('users').doc(userId).set({
        location: { latitude, longitude },
        locationUpdatedAt: new Date(),
        isOnline: true
      }, { merge: true });
    }

    res.sendStatus(200);
  } catch(e) {
    console.error('Webhook error:', e);
    res.sendStatus(200);
  }
});

// ── SOS ───────────────────────────────────────────────────────────────────────
app.post('/send-sos', async (req, res) => {
  try {
    const { senderTgId, senderName, sosType, sosLabel, lat, lng, contacts, medInfo, sosId } = req.body;
    let sent = 0;

    for (const contact of (contacts || [])) {
      let contactDoc = null;
      if (contact.tgId) {
        const snap = await db.collection('users').doc(contact.tgId).get();
        if (snap.exists) contactDoc = snap.data();
      }
      if (!contactDoc && contact.username) {
        const snap = await db.collection('users').where('tgUsername', '==', contact.username.replace('@', '')).limit(1).get();
        if (!snap.empty) contactDoc = snap.docs[0].data();
      }
      if (!contactDoc || !contactDoc.chatId) continue;

      let msg = `🆘 ${sosLabel}\n\n`;
      msg += `👤 ${senderName} нуждается в помощи!\n`;
      msg += `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}\n`;
      msg += `🗺 https://maps.google.com/?q=${lat},${lng}`;
      if (sosId) msg += `\n\n💬 Чат: откройте приложение UserKeeper`;
      if (sosType === 'red' && medInfo) {
        if (medInfo.blood) msg += `\n\n🩸 Кровь: ${medInfo.blood}`;
        if (medInfo.allergies) msg += `\n⚠️ Аллергии: ${medInfo.allergies}`;
        if (medInfo.conditions) msg += `\n🏥 Заболевания: ${medInfo.conditions}`;
        if (medInfo.meds) msg += `\n💊 Лекарства: ${medInfo.meds}`;
      }
      await sendMessage(contactDoc.chatId, msg);
      sent++;
    }
    res.json({ success: true, sent });
  } catch(e) {
    console.error('SOS error:', e);
    res.json({ success: false, error: e.message });
  }
});

app.post('/send-sos-radius', async (req, res) => {
  try {
    const { lat, lng, radius, sosLabel, senderName, senderTgId } = req.body;
    const R = radius || 1000;
    const snap = await db.collection('users').where('isOnline', '==', true).get();
    let sent = 0;

    const promises = snap.docs.map(async doc => {
      const u = doc.data();
      if (!u.location || !u.chatId || u.tgId === senderTgId) return;
      const dist = getDistance(lat, lng, u.location.latitude, u.location.longitude);
      if (dist > R) return;
      let msg = `🆘 ${sosLabel} — РЯДОМ С ВАМИ!\n\n`;
      msg += `📍 ~${Math.round(dist)}м от вас\n`;
      msg += `👤 ${senderName}\n`;
      msg += `🗺 https://maps.google.com/?q=${lat},${lng}`;
      await sendMessage(u.chatId, msg);
      sent++;
    });

    await Promise.all(promises);
    res.json({ success: true, sent });
  } catch(e) {
    console.error('Radius SOS error:', e);
    res.json({ success: false, error: e.message });
  }
});

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── VERIFICATION ──────────────────────────────────────────────────────────────
app.post('/request-verification', async (req, res) => {
  try {
    const { tgId, tgUsername, name, status, photo } = req.body;
    if (!tgId || !status || !photo) return res.json({ success: false, error: 'Missing fields' });

    const statusLabels = { med: '🏥 Мед. работник', police: '👮 Полиция / силовые', rescue: '🚒 МЧС / спасатель' };

    await db.collection('verifications').doc(tgId).set({
      tgId, tgUsername: tgUsername || null, name, status, photo,
      requestedAt: new Date(), verificationStatus: 'pending'
    });

    await db.collection('users').doc(tgId).set({ verificationStatus: 'pending' }, { merge: true });

    const adminSnap = await db.collection('users').where('tgUsername', '==', 'userkeeper').limit(1).get();
    if (!adminSnap.empty) {
      const adminData = adminSnap.docs[0].data();
      if (adminData.chatId) {
        const label = statusLabels[status] || status;
        const msg = `🪪 Запрос верификации\n\n👤 ${name}\n@${tgUsername || '—'}\n${label}\n\nID: ${tgId}\n\nВерифицировать: /verify_${tgId}\nОтклонить: /reject_${tgId}`;
        await sendMessage(adminData.chatId, msg);
      }
    }

    res.json({ success: true });
  } catch(e) {
    console.error('Verification error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ── PARENTAL CONTROL ──────────────────────────────────────────────────────────
app.post('/add-child', async (req, res) => {
  try {
    const { parentTgId, childUsername } = req.body;
    if (!parentTgId || !childUsername) return res.json({ success: false, error: 'Missing fields' });
    const username = childUsername.replace('@', '').toLowerCase();
    const snap = await db.collection('users').where('tgUsername', '==', username).limit(1).get();
    if (snap.empty) return res.json({ success: false, error: 'User not found in UserKeeper' });
    const childData = snap.docs[0].data();
    const childTgId = childData.tgId;
    const admin = require('firebase-admin');
    await db.collection('users').doc(parentTgId).set({ childrenIds: admin.firestore.FieldValue.arrayUnion(childTgId), isParent: true }, { merge: true });
    await db.collection('users').doc(childTgId).set({ parentId: parentTgId, isChild: true }, { merge: true });
    if (childData.chatId) {
      await sendMessage(childData.chatId, `👨‍👩‍👧 Вас добавили как ребёнка в UserKeeper.\n\nРодитель может видеть вашу геолокацию когда Telegram активен.\n\nЕсли это ошибка — напишите @userkeeper`);
    }
    res.json({ success: true, childName: childData.name || username, childTgId });
  } catch(e) { console.error('add-child error:', e); res.json({ success: false, error: e.message }); }
});

app.post('/get-child-location', async (req, res) => {
  try {
    const { parentTgId, childTgId } = req.body;
    if (!parentTgId || !childTgId) return res.json({ success: false, error: 'Missing fields' });
    const parentDoc = await db.collection('users').doc(parentTgId).get();
    if (!parentDoc.exists) return res.json({ success: false, error: 'Parent not found' });
    const parentData = parentDoc.data();
    if (!parentData.childrenIds || !parentData.childrenIds.includes(childTgId)) return res.json({ success: false, error: 'Not authorized' });
    const childDoc = await db.collection('users').doc(childTgId).get();
    if (!childDoc.exists) return res.json({ success: false, error: 'Child not found' });
    const d = childDoc.data();
    res.json({ success: true, name: d.name || 'Ребёнок', location: d.location || null, locationUpdatedAt: d.locationUpdatedAt || null, isOnline: d.isOnline || false });
  } catch(e) { console.error('get-child-location error:', e); res.json({ success: false, error: e.message }); }
});

app.post('/get-children', async (req, res) => {
  try {
    const { parentTgId } = req.body;
    if (!parentTgId) return res.json({ success: false, error: 'Missing parentTgId' });
    const parentDoc = await db.collection('users').doc(parentTgId).get();
    if (!parentDoc.exists) return res.json({ success: true, children: [] });
    const parentData = parentDoc.data();
    const childrenIds = parentData.childrenIds || [];
    if (!childrenIds.length) return res.json({ success: true, children: [] });
    const children = [];
    for (const childId of childrenIds) {
      const childDoc = await db.collection('users').doc(childId).get();
      if (!childDoc.exists) continue;
      const d = childDoc.data();
      children.push({ tgId: childId, name: d.name || 'Ребёнок', tgUsername: d.tgUsername || null, location: d.location || null, locationUpdatedAt: d.locationUpdatedAt || null, isOnline: d.isOnline || false });
    }
    res.json({ success: true, children });
  } catch(e) { console.error('get-children error:', e); res.json({ success: false, error: e.message }); }
});

// ── HIKING MODE ───────────────────────────────────────────────────────────────
app.post('/start-hiking', async (req, res) => {
  try {
    const { tgId, name, sessionId, intervalMinutes, startLat, startLng, startedAt } = req.body;
    if (!tgId || !sessionId) return res.json({ success: false, error: 'Missing fields' });

    const startHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ tgId, sessionId, startLat, startLng, startedAt }))
      .digest('hex');

    await db.collection('hiking_sessions').doc(sessionId).set({
      tgId, name, sessionId,
      intervalMinutes: intervalMinutes || 10,
      startLat, startLng,
      startedAt: new Date(startedAt),
      status: 'active',
      checkpoints: [],
      startHash
    });

    await db.collection('users').doc(tgId).set({
      isHiking: true,
      hikingSessionId: sessionId,
      hikingStartedAt: new Date(startedAt)
    }, { merge: true });

    console.log('Hiking started:', sessionId);
    res.json({ success: true, sessionId, startHash });
  } catch(e) {
    console.error('Start hiking error:', e);
    res.json({ success: false, error: e.message });
  }
});

app.post('/hiking-checkpoint', async (req, res) => {
  try {
    const { tgId, sessionId, lat, lng, timestamp } = req.body;
    if (!tgId || !sessionId) return res.json({ success: false, error: 'Missing fields' });

    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ tgId, sessionId, lat, lng, timestamp }))
      .digest('hex');

    const checkpoint = { lat, lng, timestamp: new Date(timestamp), hash };

    const admin = require('firebase-admin');
    await db.collection('hiking_sessions').doc(sessionId).update({
      checkpoints: admin.firestore.FieldValue.arrayUnion(checkpoint),
      lastCheckpointAt: new Date(timestamp),
      lastLat: lat,
      lastLng: lng
    });

    await db.collection('users').doc(tgId).set({
      location: { latitude: lat, longitude: lng },
      locationUpdatedAt: new Date(),
      isOnline: true
    }, { merge: true });

    console.log('Checkpoint saved:', sessionId, lat, lng);
    res.json({ success: true, hash });
  } catch(e) {
    console.error('Checkpoint error:', e);
    res.json({ success: false, error: e.message });
  }
});

app.post('/stop-hiking', async (req, res) => {
  try {
    const { tgId, sessionId, endLat, endLng, durationMinutes, endedAt } = req.body;
    if (!tgId || !sessionId) return res.json({ success: false, error: 'Missing fields' });

    const endHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ tgId, sessionId, endLat, endLng, endedAt }))
      .digest('hex');

    await db.collection('hiking_sessions').doc(sessionId).update({
      status: 'completed',
      endLat, endLng,
      durationMinutes,
      endedAt: new Date(endedAt),
      endHash
    });

    await db.collection('users').doc(tgId).set({
      isHiking: false,
      hikingSessionId: null
    }, { merge: true });

    const userDoc = await db.collection('users').doc(tgId).get();
    if (userDoc.exists && userDoc.data().chatId) {
      await sendMessage(userDoc.data().chatId,
        `🏁 Поход завершён!\n\n⏱ Длительность: ${durationMinutes} мин\n🔐 Маршрут сохранён и захеширован\n\nHash: ${endHash.substring(0, 16)}...`
      );
    }

    console.log('Hiking stopped:', sessionId, durationMinutes, 'min');
    res.json({ success: true, endHash });
  } catch(e) {
    console.error('Stop hiking error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'UserKeeper server running ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
