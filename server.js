const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.json());

// Firebase Admin init
const firebaseConfig = {
  projectId: 'userkeeper-727e1',
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

initializeApp({ credential: cert(firebaseConfig) });
const db = getFirestore();

const BOT_TOKEN = process.env.BOT_TOKEN;

// Telegram webhook
app.post('/webhook', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userId = message.from.id;
    const username = message.from.username;
    const firstName = message.from.first_name;
    const lastName = message.from.last_name || '';

    // Save user chat_id to Firebase when they send /start
    if (message.text === '/start') {
      await db.collection('users').doc(String(userId)).set({
        tgId: String(userId),
        tgUsername: username || null,
        chatId: String(chatId),
        name: firstName,
        last: lastName,
        botStarted: true,
        startedAt: new Date()
      }, { merge: true });

      // Send welcome message
      await sendMessage(chatId,
        `👋 Привет, ${firstName}!\n\nДобро пожаловать в UserKeeper 🛰\n\nТеперь ты будешь получать SOS сигналы от своих контактов.\n\nОткрой приложение через кнопку меню ниже 👇`
      );
    }

    // Handle location sharing (Live Location)
    if (message.location) {
      const { latitude, longitude } = message.location;
      await db.collection('users').doc(String(userId)).set({
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

// Send SOS to all contacts
app.post('/send-sos', async (req, res) => {
  try {
    const { senderUsername, sosType, sosLabel, lat, lng, medInfo } = req.body;
    
    // Find sender's contacts
    const snap = await db.collection('users')
      .where('tgUsername', '==', senderUsername)
      .limit(1).get();
    
    if (snap.empty) return res.json({ success: false, error: 'User not found' });
    
    const sender = snap.docs[0].data();
    const contacts = sender.contacts || [];
    
    let sent = 0;
    
    // Send to each contact that has chatId
    for (const contact of contacts) {
      if (!contact.tgId) continue;
      
      // Get contact's chatId from Firebase
      const contactDoc = await db.collection('users').doc(contact.tgId).get();
      if (!contactDoc.exists) continue;
      
      const contactData = contactDoc.data();
      if (!contactData.chatId) continue;
      
      // Build message
      let msg = `🆘 ${sosLabel}\n\n`;
      msg += `👤 ${sender.name || senderUsername} нуждается в помощи!\n`;
      msg += `📍 Координаты: ${lat.toFixed(5)}, ${lng.toFixed(5)}\n`;
      msg += `🗺 https://maps.google.com/?q=${lat},${lng}\n`;
      
      if (sosType === 'red' && medInfo) {
        if (medInfo.blood) msg += `\n🩸 Группа крови: ${medInfo.blood}`;
        if (medInfo.allergies) msg += `\n⚠️ Аллергии: ${medInfo.allergies}`;
        if (medInfo.conditions) msg += `\n🏥 Заболевания: ${medInfo.conditions}`;
        if (medInfo.meds) msg += `\n💊 Лекарства: ${medInfo.meds}`;
      }
      
      await sendMessage(contactData.chatId, msg);
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
    const { lat, lng, radius, sosLabel, sosType, senderName, medInfo } = req.body;
    const R = radius || 1000; // meters
    
    // Get all online users
    const snap = await db.collection('users').where('isOnline', '==', true).get();
    
    let sent = 0;
    
    snap.docs.forEach(async doc => {
      const u = doc.data();
      if (!u.location || !u.chatId) return;
      
      // Calculate distance
      const dist = getDistance(lat, lng, u.location.latitude, u.location.longitude);
      if (dist > R) return;
      
      let msg = `🆘 ${sosLabel} — РЯДОМ С ВАМИ!\n\n`;
      msg += `📍 Расстояние: ~${Math.round(dist)}м\n`;
      msg += `👤 ${senderName}\n`;
      msg += `🗺 https://maps.google.com/?q=${lat},${lng}`;
      
      await sendMessage(u.chatId, msg);
      sent++;
    });
    
    res.json({ success: true, sent });
  } catch(e) {
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

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

app.get('/', (req, res) => res.json({ status: 'UserKeeper server running ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
