// Organisation chart from the growth plan v2 (target Dec 2027: 98 people +
// owner). [code, title, level, section, reports-to code, planned seats,
// salary band, default app role, note]. Section totals: Sales 38, Service 21,
// Operations 25, Support 14. Authorised service partners are outside payroll.
module.exports = [
  // Level 1
  ['owner', 'Owner / Director', 1, 'Leadership', null, 1, '', 'admin', 'Strategy, Bull relationship, finance, key accounts, guidance of service partners'],

  // Level 2 — heads
  ['head_sales',   'Head of Sales',                2, 'Sales',      'owner', 1, '₹80–90k', 'manager', 'Owns the ₹100 Cr number'],
  ['head_service', 'Head of Service',              2, 'Service',    'owner', 1, '₹70–80k', 'manager', 'Uptime, warranty, service partners'],
  ['head_ops',     'Head of Operations (GM)',      2, 'Operations', 'owner', 1, '₹80–90k', 'manager', 'Deliveries, stock, branches'],
  ['head_finance', 'Head of Finance and Admin',    2, 'Support',    'owner', 1, '₹70–80k', 'head_of_finance', 'Accounts, cash, HR, compliance; approves all expenses'],

  // Level 3 — managers
  ['rsm',                 'Regional Sales Manager',          3, 'Sales',      'head_sales',   3, '₹45–55k + incentive', 'manager',          'Meerut region, North region, NCR'],
  ['workshop_mgr',        'Meerut Workshop Manager',         3, 'Service',    'head_service', 1, '₹40–45k',             'service',          ''],
  ['asp_network_mgr',     'ASP Network Manager',             3, 'Service',    'head_service', 1, '₹40–45k',             'service',          'Runs and audits the service partners'],
  ['logistics_parts_mgr', 'Logistics and Parts Manager',     3, 'Operations', 'head_ops',     1, '₹38–45k',             'office',           ''],
  ['finance_rto_mgr',     'Finance-file and RTO Manager',    3, 'Operations', 'head_ops',     1, '₹38–45k',             'office',           ''],
  ['ncr_branch_mgr',      'NCR Branch Manager',              3, 'Operations', 'head_ops',     1, '₹38–45k',             'manager',          ''],
  ['accounts_mgr',        'Accounts Manager',                3, 'Support',    'head_finance', 1, '₹38–45k',             'accounts_manager', ''],
  ['hr_admin_mgr',        'HR and Admin Manager',            3, 'Support',    'head_finance', 1, '₹38–45k',             'hr',               ''],

  // Level 4 — leads and seniors
  ['area_sales_lead',      'Area Sales Lead',                    4, 'Sales',      'rsm',                 6, '₹28–35k', 'sales',      '4 West UP, 2 NCR'],
  ['sales_desk_lead',      'Sales Desk (CRM) Lead',              4, 'Sales',      'head_sales',          1, '₹28–35k', 'telecaller', ''],
  ['area_service_lead',    'Area Service Lead',                  4, 'Service',    'asp_network_mgr',     3, '₹26–32k', 'service',    'Train and audit service partners'],
  ['senior_engineer',      'Senior Hydraulic and Engine Engineer', 4, 'Service',  'workshop_mgr',        2, '₹26–32k', 'service',    ''],
  ['stock_parts_incharge', 'Stock and Parts In-charge',          4, 'Operations', 'logistics_parts_mgr', 2, '₹24–28k', 'office',     ''],
  ['documentation_lead',   'Documentation Lead',                 4, 'Operations', 'finance_rto_mgr',     1, '₹24–28k', 'office',     ''],
  ['delivery_pdi_coord',   'Delivery and PDI Coordinator',       4, 'Operations', 'logistics_parts_mgr', 1, '₹24–28k', 'office',     ''],
  ['senior_accountant',    'Senior Accountant',                  4, 'Support',    'accounts_mgr',        1, '₹25–30k', 'accountant', ''],
  ['payroll_hr_exec',      'Payroll and HR Executive',           4, 'Support',    'hr_admin_mgr',        1, '₹25–30k', 'hr',         ''],
  ['mis_it_lead',          'MIS and IT Lead',                    4, 'Support',    'head_finance',        1, '₹25–30k', 'office',     ''],

  // Level 5 — executives and staff
  ['sales_officer',       'Sales Officer',                     5, 'Sales',      'area_sales_lead',      22, 'Fresher ₹16k, experienced ₹20k + incentive', 'sales',      '16 West UP, 6 NCR'],
  ['sales_coordinator',   'Sales Coordinator',                 5, 'Sales',      'sales_desk_lead',       5, '₹15k',     'telecaller', ''],
  ['service_engineer',    'Service Engineer / Technician',     5, 'Service',    'senior_engineer',      10, '₹15–18k',  'service',    'Meerut workshop and roving'],
  ['service_coordinator', 'Service Coordinator',               5, 'Service',    'workshop_mgr',          3, '₹13–15k',  'service',    ''],
  ['loan_rto_exec',       'Loan and RTO Executive',            5, 'Operations', 'documentation_lead',    6, '₹15k',     'office',     ''],
  ['store_parts_exec',    'Store and Parts Executive',         5, 'Operations', 'stock_parts_incharge',  4, '₹13k',     'office',     ''],
  ['driver',              'Driver',                            5, 'Operations', 'delivery_pdi_coord',    4, '₹15k',     'employee',   ''],
  ['pdi_helper',          'PDI Helper',                        5, 'Operations', 'delivery_pdi_coord',    3, '₹12k',     'employee',   ''],
  ['accountant',          'Accountant',                        5, 'Support',    'senior_accountant',     3, '₹18k',     'accountant', ''],
  ['admin_exec',          'Admin Executive',                   5, 'Support',    'hr_admin_mgr',          1, '₹15k',     'office',     ''],
  ['peon',                'Peon',                              5, 'Support',    'hr_admin_mgr',          2, '₹10k',     'employee',   ''],
  ['helper',              'Helper',                            5, 'Support',    'hr_admin_mgr',          2, '₹10k',     'employee',   ''],
];
