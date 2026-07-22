-- Run this in cPanel → phpMyAdmin → select your database → SQL tab
-- (Only needed if the Node app cannot create the table automatically.)

CREATE TABLE IF NOT EXISTS orders (
  seq INT AUTO_INCREMENT PRIMARY KEY,
  id CHAR(36) NOT NULL UNIQUE,
  order_number VARCHAR(20) NULL UNIQUE,
  status VARCHAR(32) NOT NULL,
  buyer_email VARCHAR(255) NOT NULL,
  course_id VARCHAR(32) NOT NULL,
  provider VARCHAR(16) NOT NULL,
  provider_ref VARCHAR(64) NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'BWP',
  data JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_orders_status (status),
  INDEX idx_orders_buyer_email (buyer_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
