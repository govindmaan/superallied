// Hindi translations, keyed by the English text shown in the app (see lib/i18n.js).
// Missing keys show in English. {name} placeholders carry values through.
// Terms follow the agreed glossary: Leads = संभावित ग्राहक, Follow-up = फॉलो-अप,
// Pending = लंबित, Converted = बिक्री में परिवर्तित, Lost = असफल, Remarks = टिप्पणी,
// Save = सुरक्षित करें, Submit = जमा करें, Assigned To = जिम्मेदार कर्मचारी.
// Interface text only: database values and exports/PDFs stay English.
module.exports = Object.assign({},
  require('./hi/ui-a-l'),
  require('./hi/ui-m-z'),
  require('./hi/messages'),
  require('./hi/screens'),
  require('./hi/glossary'),  // last: the agreed glossary wins
);
