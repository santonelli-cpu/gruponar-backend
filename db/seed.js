// Crea el primer usuario admin. Uso:
//   ADMIN_EMAIL=tu@correo.com ADMIN_PASSWORD=algoSeguro123 ADMIN_NAME="Tu Nombre" npm run seed
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('./index');

const name = process.env.ADMIN_NAME || 'Admin Grupo Nar';
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;

if (!email || !password) {
  console.error('Define ADMIN_EMAIL y ADMIN_PASSWORD como variables de entorno antes de correr el seed.');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  console.log('Ya existe un usuario con ese correo. No se creó ninguno nuevo.');
  process.exit(0);
}

const hash = bcrypt.hashSync(password, 12);
db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
  .run(name, email, hash, 'admin');

console.log(`Usuario admin creado: ${email}`);
