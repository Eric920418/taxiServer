#!/usr/bin/env node

// 用於創建管理員帳號的腳本
const bcrypt = require('bcryptjs');

async function createAdminHash() {
  const password = 'admin123'; // 預設密碼
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);

  console.log('Password:', password);
  console.log('Hash:', hash);
  console.log('\n將這個 hash 複製到 create_admin_tables.sql 中的 password_hash 欄位');

  // 測試驗證
  const isValid = await bcrypt.compare(password, hash);
  console.log('驗證測試:', isValid ? '成功' : '失敗');
}

createAdminHash().catch(console.error);