// Database entry point. Startup order matters:
//   tables → later-added columns → indexes → accounts module → seed data → data migrations
// so a brand-new database and the long-running production one end up identical.
const db = require('./connection');
const { createTables } = require('./schema');
const { addColumns } = require('./columns');
const { createIndexes } = require('./indexes');
const { seed } = require('./seed');
const { migrate } = require('./migrations');
const helpers = require('./helpers');

createTables();
addColumns();
createIndexes();
require('../services/accounts/schema')(db);
seed();
migrate();

const { EMP_CODE_START, ...api } = helpers;
module.exports = { db, ...api };
