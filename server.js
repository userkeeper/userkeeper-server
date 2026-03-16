const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.json());

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

// Webhook from Telegram
app.post('/webhook', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.sendStatus(200);

    const chatId = String(message.chat.id);
    const userId = String(message.from.id);
    const username = message.from.username || null;
    const firstName = message.from.first_name || '';
    const lastName = message.from.last_name || '';

    if (message.text === '/start') {
      await db.collection('users').doc(userId).set({
        tgId: userId,
        tgUsername: username,
        chatId,
        name: firstName,
        last: lastName,
        botStarted: true,
        startedAt: new Date()
      }, { merge: true });

      await sendMessage(chatId,
        `👋 Привет, ${firstName}!\n\nДобро пожаловать в UserKeeper 🛰\n\nТеперь ты будешь получать SOS сигналы от своих контактов.\n\nОткрой приложение через кнопку меню ниже 👇`
      );
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

// Send SOS to contacts
app.post('/send-sos', async (req, res) => {
  try {
    const { senderTgId, senderName, sosType, sosLabel, lat, lng, contacts, medInfo } = req.body;
    let sent = 0;

    for (const contact of (contacts || [])) {
      let contactDoc = null;

      if (contact.tgId) {
        const snap = await db.collection('users').doc(contact.tgId).get();
        if (snap.exists) contactDoc = snap.data();
      }

      if (!contactDoc && contact.username) {
        const username = contact.username.replace('@', '');
        const snap = await db.collection('users').where('tgUsername', '==', username).limit(1).get();
        if (!snap.empty) contactDoc = snap.docs[0].data();
      }

      if (!contactDoc || !contactDoc.chatId) continue;

      let msg = `🆘 ${sosLabel}\n\n`;
      msg += `👤 ${senderName} нуждается в помощи!\n`;
      msg += `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}\n`;
      msg += `🗺 https://maps.google.com/?q=${lat},${lng}`;

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

// Send SOS to users in radius
app.post('/send-sos-radius', async (req, res) => {
  try {
    const { lat, lng, radius, sosLabel, sosType, senderName, senderTgId, medInfo } = req.body;
    const R = radius || 1000;

    const snap = await db.collection('users').where('isOnline', '==', true).get();
    let sent = 0;

    const promises = snap.docs.map(async doc => {
      const u = doc.data();
      if (!u.location || !u.chatId) return;
      if (u.tgId === senderTgId) return;

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

app.get('/', (req, res) => res.json({ status: 'UserKeeper server running ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
