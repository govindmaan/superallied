// Indexes, created after columns.js so an index can use a later-added column.
const db = require('./connection');

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_users_position ON users(position_code);",
  "CREATE INDEX IF NOT EXISTS idx_specs_machine ON machine_specs(machine_id);",
  "CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);",
  "CREATE INDEX IF NOT EXISTS idx_att_user ON attendance(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_leaves_user ON leaves(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);",
  "CREATE INDEX IF NOT EXISTS idx_visits_user ON field_visits(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_visits_time ON field_visits(visit_time);",
  "CREATE INDEX IF NOT EXISTS idx_journey_user ON expense_journeys(user_id, date);",
  "CREATE INDEX IF NOT EXISTS idx_travelexp_user ON travel_expenses(user_id, status);",
  "CREATE INDEX IF NOT EXISTS idx_expdocs_expense ON expense_documents(expense_id);",
  "CREATE INDEX IF NOT EXISTS idx_sold_machine_no ON sold_machines(machine_no);",
  "CREATE INDEX IF NOT EXISTS idx_sold_customer ON sold_machines(customer_name);",
  "CREATE INDEX IF NOT EXISTS idx_sold_mobile ON sold_machines(mobile_1);",
  "CREATE INDEX IF NOT EXISTS idx_parts_sap ON spare_parts(sap_part_no);",
  "CREATE INDEX IF NOT EXISTS idx_parts_rnd ON spare_parts(rnd_part_no);",
  "CREATE INDEX IF NOT EXISTS idx_sq_machine_no ON spare_quotations(machine_no);",
  "CREATE INDEX IF NOT EXISTS idx_sq_date ON spare_quotations(created_at);",
  "CREATE INDEX IF NOT EXISTS idx_sq_status ON spare_quotations(status);",
  "CREATE INDEX IF NOT EXISTS idx_sqi_quotation ON spare_quotation_items(quotation_id);",
  "CREATE INDEX IF NOT EXISTS idx_poi_order ON part_order_items(order_id);",
  "CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);",
  "CREATE INDEX IF NOT EXISTS idx_enq_phone    ON enquiries(phone);",
  "CREATE INDEX IF NOT EXISTS idx_enq_assigned ON enquiries(assigned_to);",
  "CREATE INDEX IF NOT EXISTS idx_enq_stage    ON enquiries(current_stage);",
  "CREATE INDEX IF NOT EXISTS idx_enq_status   ON enquiries(status);",
  "CREATE INDEX IF NOT EXISTS idx_enq_district ON enquiries(district);",
  "CREATE INDEX IF NOT EXISTS idx_fu_enquiry ON enquiry_followups(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_fu_next    ON enquiry_followups(next_followup_date);",
  "CREATE INDEX IF NOT EXISTS idx_visit_enquiry ON enquiry_visits(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_enqvisit_user_time ON enquiry_visits(created_by, created_at);",
  "CREATE INDEX IF NOT EXISTS idx_eq_enquiry ON enquiry_quotations(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_eqi_quotation ON enquiry_quotation_items(quotation_id);",
  "CREATE INDEX IF NOT EXISTS idx_sale_enquiry ON enquiry_sales(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_remark_enquiry ON enquiry_remarks(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_att_enquiry ON enquiry_attachments(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_databank_district ON databank(district, village);",
  "CREATE INDEX IF NOT EXISTS idx_databank_village  ON databank(village COLLATE NOCASE);",
  "CREATE INDEX IF NOT EXISTS idx_databank_name     ON databank(name COLLATE NOCASE);",
  "CREATE INDEX IF NOT EXISTS idx_databank_remarks ON databank_remarks(databank_id);",
  "CREATE INDEX IF NOT EXISTS idx_call_logs_enquiry ON call_logs(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_call_logs_user    ON call_logs(user_id, called_at);",
  "CREATE INDEX IF NOT EXISTS idx_territory_districts ON territory_districts(territory_id);",
  "CREATE INDEX IF NOT EXISTS idx_lead_shares_enquiry ON lead_shares(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_lead_activity_enquiry ON lead_activity(enquiry_id);",
  "CREATE INDEX IF NOT EXISTS idx_visits_user_time ON field_visits(user_id, visit_time);",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sq_share_token ON spare_quotations(share_token);",
];

function createIndexes() {
  INDEXES.forEach(sql => db.exec(sql));
}

module.exports = { createIndexes };
