'use strict';

const { hashPassword } = require('../crypto');

/**
 * DEMO-ONLY users. The prototype's hard-coded credentials (abcdefg/123456,
 * admin/123456) deliberately do NOT exist here. Passwords are hashed with
 * scrypt and must be changed in any non-demo deployment (DEMO_MODE=false
 * skips this seed entirely).
 */
const DEMO_USERS = [
  { id: 'usr_admin', email: 'admin@smartplant.local', password: 'Admin123!', displayName: 'Aisha Verma', role: 'ADMIN', locale: 'en' },
  { id: 'usr_manager', email: 'manager@smartplant.local', password: 'Manager123!', displayName: 'Rahul Nair', role: 'MANAGER', locale: 'en' },
  { id: 'usr_supervisor', email: 'supervisor@smartplant.local', password: 'Supervisor123!', displayName: 'Meera Iyer', role: 'SUPERVISOR', locale: 'en' },
  { id: 'usr_technician', email: 'technician@smartplant.local', password: 'Technician123!', displayName: 'Vikram Singh', role: 'TECHNICIAN', locale: 'en' },
  { id: 'usr_worker', email: 'worker@smartplant.local', password: 'Worker123!', displayName: 'Lakshmi Rao', role: 'WORKER', locale: 'hi' },
  { id: 'usr_viewer', email: 'viewer@smartplant.local', password: 'Viewer123!', displayName: 'Guest Viewer', role: 'VIEWER', locale: 'te' },
];

function seedUsers(db) {
  const stmt = db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, role, status, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
  );
  for (const u of DEMO_USERS) {
    const ts = new Date().toISOString();
    stmt.run(u.id, u.email, hashPassword(u.password), u.displayName, u.role, u.locale, ts, ts);
  }
}

module.exports = { DEMO_USERS, seedUsers };
