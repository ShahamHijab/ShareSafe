export type Category = "Email" | "Pakistan phone" | "Pakistan address" | "CNIC" | "IP address" | "URL" | "Possible secret";

export type Rect = { x: number; y: number; width: number; height: number };

export type Detection = {
  id: string;
  category: Category;
  text: string;
  confidence: "Pattern match" | "Heuristic";
  rect: Rect;
  selected: boolean;
};
