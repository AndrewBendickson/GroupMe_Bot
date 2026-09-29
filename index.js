// index.js
// GroupMe anti-ticket-scam bot (Node.js + Express)
// Make sure you have a .env with: PORT=3000, GROUPME_BOT_ID=..., (optional) GROUPME_ADMIN_TOKEN=...

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path} ct=${req.headers['content-type'] || 'n/a'}`);
  next();
});

const PORT = process.env.PORT || 3000;
const BOT_ID = process.env.GROUPME_BOT_ID;
const ADMIN_USER_TOKEN = process.env.GROUPME_ADMIN_TOKEN || null;

// --- Scam detector (lenient for Auburn ticket phrasing) ---
function looksLikeTicketScam(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  const ticketWords = ['ticket', 'tickets', 'pass', 'season', 'student pass'];
  const sellWords = ['sell', 'selling', 'for sale', 'fs'];
  const teams = ['alabama', 'bama', 'uga', 'georgia', 'auburn', 'iron bowl', 'sec', 'uga', 'bama'];
  const paymentCues = ['venmo', 'cashapp', 'paypal', 'zelle'];
  const dmCues = ['dm me', 'message me', 'pm me', 'text me', 'inbox me', 'dm if interested', 'dm if ur interested'];

  const hasTicket = ticketWords.some(w => t.includes(w));
  const mentionsSale = sellWords.some(w => t.includes(w));
  const mentionsTeams = teams.some(w => t.includes(w));
  const asksToDM = dmCues.some(w => t.includes(w)) || /dm (me|for|if)/.test(t);
  const hasUrl = /https?:\/\//.test(t) || /\bbit\.ly\b/.test(t) || /\bt\.me\//.test(t);
  const asksForPay = paymentCues.some(w => t.includes(w)) || t.includes('pay');

  // Heuristic: talking about tickets + (selling or team/game context) AND (DM or URL or payment)
  return hasTicket && (mentionsSale || mentionsTeams) && (asksToDM || hasUrl || asksForPay);
}

// --- Helpers to talk to GroupMe ---
async function botPost(text) {
  if (!BOT_ID) {
    console.error('BOT_ID missing — set GROUPME_BOT_ID in .env');
    return;
  }
  try {
    await axios.post('https://api.groupme.com/v3/bots/post', {
      bot_id: BOT_ID,
      text
    });
  } catch (e) {
    console.error('botPost error:', e.response?.data || e.message);
  }
}

// Remove a member by membership_id (requires admin token)
async function removeMember(groupId, membershipId) {
  if (!ADMIN_USER_TOKEN) throw new Error('No admin token set');
  const url =
    `https://api.groupme.com/v3/groups/${groupId}/members/${membershipId}/remove?token=${ADMIN_USER_TOKEN}`;
  return axios.post(url);
}

// Look up membership_id for a user in the group (requires admin token)
async function getMembershipId(groupId, userId, nickname) {
  if (!ADMIN_USER_TOKEN) return null;
  const url = `https://api.groupme.com/v3/groups/${groupId}?token=${ADMIN_USER_TOKEN}`;
  const res = await axios.get(url);
  const members = res.data?.response?.members || [];
  const m = members.find(m =>
    m.user_id === userId || m.nickname?.toLowerCase() === (nickname || '').toLowerCase()
  );
  return m?.id || null;
}

// --- Webhook: be flexible about GroupMe payload shape ---
app.post('/groupme/callback', async (req, res) => {
  try {
    const body = req.body || {};

    // GroupMe may send just the message object, or a wrapper { type: "message.created", message: {...} }
    const isWrapped = body.type === 'message.created' && body.message;
    const msg = isWrapped ? body.message : body;

    // Extract fields defensively
    const text = msg?.text || '';
    const groupId = msg?.group_id;
    const posterName = msg?.name || 'someone';
    const posterUserId = msg?.user_id;
    const senderType = msg?.sender_type; // "user", "system", "bot"
    console.log('Incoming message:', { text, posterName, senderType });
    // Ignore anything not from a human user (avoid loops & system pings)
    if (senderType && senderType !== 'user') {
      return res.sendStatus(200);
    }

    if (looksLikeTicketScam(text)) {
      await botPost(
        `⚠️ Heads up: this looks like a ticket scam posted by ${posterName}. Do **not** DM or send money. Admins have been notified.`
      );

      // Optional auto-removal:
      if (ADMIN_USER_TOKEN && groupId && posterUserId) {
        try {
          const membershipId = await getMembershipId(groupId, posterUserId, posterName);
          if (membershipId) {
            await removeMember(groupId, membershipId);
            await botPost(
              `User ${posterName} was removed automatically for suspected scam. If this was an error, contact admins.`
            );
          } else {
            await botPost(`Couldn’t find membership for ${posterName}. Admins please review.`);
          }
        } catch (err) {
          console.error('Auto-remove failed:', err.response?.data || err.message);
          await botPost(`Tried to auto-remove ${posterName} but hit an error. Admins please review.`);
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(200);
  }
});

// Health/landing
app.get('/', (_req, res) => res.send('GroupMe bot is running'));

app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
