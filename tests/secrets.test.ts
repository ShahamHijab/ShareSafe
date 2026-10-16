import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPatterns } from "../lib/detectPatterns";
import { assessToken } from "../lib/entropy";
import { B64, B64URL, HEXCHARS, ocrLines, randomString, rng } from "./helpers";

// Fake credentials are assembled from pieces so this file never contains a string that
// secret scanners (or GitHub push protection) would mistake for a real key.
const stripeSecret = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const stripeTest = "sk_" + "test_" + "51H8xYzAbCdEfGhIjKlMnOpQrStUvWx";
const stripeRestricted = "rk_" + "live_" + "AbCdEfGhIjKlMnOpQrStUvWx12";
const stripePublishable = "pk_" + "live_" + "TYooMQauvdEDq54NiTphI7jx";
const stripeWebhook = "whsec_" + "t2Xo5FQp0sGpL7bY9kRzN3vD1cHaW8mE";
const stripeClientSecret = "pi_" + "3MtwBwLkdIwHu7ix28a3tqPa" + "_secret_" + "YrKJUKribcBjcG8HVhfZluoGH";
const googleApi = "AIza" + "SyA-1234567890abcdefghijklmnopqrstu";
const googleSecret = "GOCSPX-" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ12";
const googleAccess = "ya29." + "a0AfH6SMBx1234567890abcdefghijklmnop";
const slackBot = "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx";
const slackApp = "xapp-" + "1-A0123456789-1234567890123-0123456789abcdef0123456789abcdef";
const slackHook = "https://hooks.slack.com/services/" + "T01234ABCDE/B01234FGHIJ/AbCdEfGhIjKlMnOpQrStUvWx";
const jwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" + "." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

function categories(lines: string[], gapAfter?: Record<number, number>) {
  return detectPatterns(ocrLines(lines, { gapAfter })).map((d) => d.category);
}

test("Stripe keys", () => {
  for (const key of [stripeSecret, stripeTest, stripeRestricted, stripeWebhook, stripeClientSecret]) {
    const found = detectPatterns(ocrLines([`STRIPE_KEY ${key}`]));
    assert.ok(found.some((d) => d.category === "Stripe key" && d.confidence === "Pattern match"), key);
  }
  const pk = detectPatterns(ocrLines([`publishable ${stripePublishable}`])).find((d) => d.category === "Stripe key");
  assert.equal(pk?.confidence, "Heuristic");
});

test("Google keys", () => {
  for (const key of [googleApi, googleSecret, googleAccess]) {
    assert.ok(categories([`token ${key}`]).includes("Google key"), key);
  }
});

test("Slack tokens and webhooks (webhook beats the generic URL rule)", () => {
  for (const key of [slackBot, slackApp, slackHook]) {
    const cats = categories([`${key}`]);
    assert.ok(cats.includes("Slack token"), key);
    assert.ok(!cats.includes("URL"), `${key} should not also be labelled URL`);
  }
});

test("JWT, including OCR spaces beside the dots", () => {
  assert.ok(categories([`Authorization: Bearer ${jwt}`]).includes("JWT"));
  const [h, p, s] = jwt.split(".");
  assert.ok(categories([`${h} . ${p} . ${s}`]).includes("JWT"));
});

test("PEM private key: full block, cut-off block, one-line JSON, and bare header", () => {
  const body = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj", "MBzQe5tOXkq0WwnKd5PDKxVj1l9R6ZgQy8Cq2oAvD3sJhP4uLtXbNfEiGm7RwYzA", "w1QvB8kJ2nXcP0sDfGhLzUyTr4Ee6IoOaS9VmNbHjKlQpWxZc3AqSdFgHyJuIkLo"];
  const full = detectPatterns(ocrLines(["my key:", "-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----", "thanks!"]));
  const keys = full.filter((d) => d.category === "Private key");
  assert.equal(keys.length, 1);
  assert.equal(full.filter((d) => d.category === "High-entropy string").length, 0, "body lines must not also be flagged separately");
  const top = ocrLines(["my key:", "-----BEGIN PRIVATE KEY-----"]).at(-1)!.bbox.y0;
  assert.ok(keys[0].rect.y <= top + 1, "box starts at the BEGIN line");
  assert.ok(keys[0].rect.y + keys[0].rect.height >= 10 + 5 * 26, "box reaches the END line");

  // Cut off at the bottom of the screenshot: no END line.
  const cut = detectPatterns(ocrLines(["-----BEGIN RSA PRIVATE KEY-----", ...body.slice(0, 2)])).filter((d) => d.category === "Private key");
  assert.equal(cut.length, 1);

  // JSON-escaped (service-account style): one very long line.
  const json = `"private_key": "-----BEGIN PRIVATE KEY-----\\n${body.join("\\n")}\\n-----END PRIVATE KEY-----\\n"`;
  assert.ok(categories([json]).includes("Private key"));

  // PGP flavour and OpenSSH flavour.
  assert.ok(categories(["-----BEGIN PGP PRIVATE KEY BLOCK-----", ...body, "-----END PGP PRIVATE KEY BLOCK-----"]).includes("Private key"));
  assert.ok(categories(["-----BEGIN OPENSSH PRIVATE KEY-----", ...body, "-----END OPENSSH PRIVATE KEY-----"]).includes("Private key"));

  // A header alone, or a PUBLIC key, is not flagged.
  assert.ok(!categories(["-----BEGIN PRIVATE KEY-----", "see docs for how to generate one"]).includes("Private key"));
  assert.ok(!categories(["-----BEGIN PUBLIC KEY-----", ...body, "-----END PUBLIC KEY-----"]).includes("Private key"));

  // Text far below the block is left alone.
  const gap = detectPatterns(ocrLines(["-----BEGIN PRIVATE KEY-----", body[0], "-----END PRIVATE KEY-----", body[1]], { gapAfter: { 2: 80 } }));
  const k = gap.find((d) => d.category === "Private key")!;
  assert.ok(k.rect.height < 100);
});

test("entropy: random tokens are caught", () => {
  const next = rng(42);
  let missed = 0;
  let longMissed = 0;
  let longTotal = 0;
  const total = 600;
  for (let i = 0; i < total; i++) {
    const length = 20 + Math.floor(next() * 45);
    const alphabet = i % 3 === 0 ? B64URL : B64;
    const token = randomString(next, length, alphabet);
    const flagged = assessToken(token).random;
    if (!flagged) missed++;
    if (length >= 32) { longTotal++; if (!flagged) longMissed++; }
  }
  assert.ok(missed / total < 0.1, `missed ${missed}/${total} random base64 tokens`);
  assert.ok(longMissed / longTotal < 0.03, `missed ${longMissed}/${longTotal} tokens of 32+ chars`);

  let hexMissed = 0;
  for (let i = 0; i < 200; i++) if (!assessToken(randomString(next, 32 + 8 * (i % 5), HEXCHARS)).random) hexMissed++;
  assert.ok(hexMissed / 200 < 0.02, `missed ${hexMissed}/200 hex secrets`);
});

test("entropy: assignments such as sid=VALUE cover only the value", () => {
  const value = randomString(rng(7), 40, B64);
  const words = ocrLines([`sid=${value}`]);
  const found = detectPatterns(words).filter((d) => d.category === "High-entropy string");
  assert.equal(found.length, 1);
  assert.equal(found[0].text, value);
  assert.ok(found[0].rect.x > words[0].bbox.x0, "box starts after 'sid='");
});

test("entropy: ordinary technical text is not flagged", () => {
  const hash = randomString(rng(9), 40, HEXCHARS);
  const safe = [
    "getUserAccountBalanceFromDatabase", "ThisIsAVeryLongVariableNameForTesting", "MAX_RETRY_COUNT_FOR_REQUESTS_2024",
    "internationalizationConfiguration", "src/components/ui/dialog/DialogContent", "background-color-transition-duration",
    "550e8400-e29b-41d4-a716-446655440000", "2024-03-15-12-34-56-789012345", "12345678901234567890123",
    "authenticationMiddlewareHandler2", "com.example.application.MainActivity", "https://example.com/some/very/long/path/to/page",
    "supercalifragilisticexpialidocious", "lowercaseonlytokenwithnodigitsatall", "UPPERCASEONLYTOKENWITHNODIGITSATALL",
    "IMG_20240315_123456_789012345_HDR", "TransactionSuccessfulReceiptDetailsPage", "node_modules/react-dom/cjs/react-dom.production.min.js",
  ];
  for (const token of safe) assert.equal(assessToken(token).random, false, token);
  // A git SHA is not a secret when the line says so; an unlabeled 40-hex string still is flagged.
  assert.equal(assessToken(hash, `commit ${hash}`).random, false);
  assert.equal(assessToken(hash, `token ${hash}`).random, true);
  // Ordinary prose and short words never reach the check.
  const prose = ocrLines(["The quick brown fox jumps over the lazy dog while everyone watches carefully from afar"]);
  assert.equal(detectPatterns(prose).filter((d) => d.category === "High-entropy string").length, 0);
});

test("existing detections still work and are not double-counted", () => {
  const found = detectPatterns(ocrLines(["contact ali@example.com or 0300 1234567", `key ${stripeSecret}`]));
  const cats = found.map((d) => d.category);
  assert.ok(cats.includes("Email"));
  assert.ok(cats.includes("Pakistan phone"));
  assert.equal(cats.filter((c) => c === "Stripe key").length, 1);
  assert.ok(!cats.includes("High-entropy string"), "a key matched by name must not also be an entropy hit");
});
