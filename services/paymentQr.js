// Payment QR for quotations, built from the master Settings every time.
// Payee: the UPI ID in Settings if set; otherwise the master bank account, using
// the NPCI "pay to account" address <account>@<IFSC>.ifsc.npci. The amount and
// quotation number are filled in, so the customer only has to confirm and pay.
// UPI normally caps one payment at ₹1 lakh, so larger amounts are left for the
// customer to enter (a pre-filled ₹35 lakh would just be rejected by the app).
const QRCode = require('qrcode');

function upiPayee(s) {
  const upi = String(s.company_upi || '').trim();
  if (/^[\w.\-]{2,}@[a-z][\w.\-]*$/i.test(upi)) return { vpa: upi, via: 'upi' };
  const acct = String(s.bank_account || '').replace(/\s+/g, '');
  const ifsc = String(s.bank_ifsc || '').replace(/\s+/g, '').toUpperCase();
  if (/^\d{6,18}$/.test(acct) && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return { vpa: `${acct}@${ifsc}.ifsc.npci`, via: 'bank' };
  return null;
}

const UPI_PREFILL_MAX = 100000;

async function paymentQr(s, amount, note) {
  const payee = upiPayee(s);
  if (!payee) return null;
  const am = Math.round((parseFloat(amount) || 0) * 100) / 100;
  // Payee address goes in as-is (payment apps expect a literal "@"); other values are encoded
  const prefilled = am > 0 && am <= UPI_PREFILL_MAX;
  const parts = [`pa=${payee.vpa}`, `pn=${encodeURIComponent(s.bank_beneficiary || s.company_name || 'Super Allied')}`];
  if (prefilled) parts.push(`am=${am.toFixed(2)}`);
  parts.push('cu=INR');
  if (note) parts.push(`tn=${encodeURIComponent(String(note).slice(0, 50))}`);
  const dataUrl = await QRCode.toDataURL('upi://pay?' + parts.join('&'), { width: 220, margin: 1, errorCorrectionLevel: 'M' });
  return { dataUrl, payee: payee.vpa, via: payee.via, amount: prefilled ? am : null };
}

module.exports = { paymentQr, upiPayee };
