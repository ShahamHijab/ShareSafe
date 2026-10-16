import type { Category } from "./types";

// Short glyphs shown beside each detection in the review list.
export const categoryIcons: Record<Category, string> = {
  Email: "@",
  "Pakistan phone": "☎",
  "Pakistan address": "⌂",
  "Bank account": "₨",
  "Person name": "☺",
  CNIC: "ID",
  "IP address": "IP",
  URL: "↗",
  "Possible secret": "••",
  "Stripe key": "••",
  "Google key": "••",
  "Slack token": "••",
  JWT: "••",
  "Private key": "🔑",
  "High-entropy string": "≈",
  "QR code": "▦",
  Barcode: "▮▯",
};
