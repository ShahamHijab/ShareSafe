export type Category =
  | "Email"
  | "Pakistan phone"
  | "Pakistan address"
  | "Bank account"
  | "Person name"
  | "CNIC"
  | "IP address"
  | "URL"
  | "Possible secret"
  | "Stripe key"
  | "Google key"
  | "Slack token"
  | "JWT"
  | "Private key"
  | "High-entropy string"
  | "QR code"
  | "Barcode";

export type Rect = { x: number; y: number; width: number; height: number };

export type Detection = {
  id: string;
  category: Category;
  text: string;
  confidence: "Pattern match" | "Heuristic";
  rect: Rect;
  selected: boolean;
};
