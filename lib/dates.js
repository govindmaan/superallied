// India-time date helpers. The server runs with TZ=Asia/Kolkata, but these add
// +5:30 explicitly so they stay correct even if TZ is not applied.
const IST_OFFSET_MS = 330 * 60000;

// Today's date in India as YYYY-MM-DD
const todayIST = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
// Current India time as 'YYYY-MM-DD HH:MM:SS'
const nowIST = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');

module.exports = { todayIST, nowIST };
