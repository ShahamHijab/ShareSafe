import Link from "next/link";
import { Header } from "@/components/Header";
import { ArrowIcon, LockIcon } from "@/components/Icons";

export default function HomePage() {
  return (
    <main>
      <Header />
      <section className="landing">
        <div className="sticker sticker-a" aria-hidden="true">🙈</div>
        <div className="sticker sticker-b" aria-hidden="true">✨</div>
        <div className="sticker sticker-c" aria-hidden="true">🔒</div>

        <p className="pill">100% in your browser</p>
        <h1>Hide the <span className="scribble">private</span> stuff.</h1>
        <p className="lead">What are we cleaning up today?</p>

        <div className="choice-grid">
          <Link href="/image" className="choice choice-image">
            <div className="choice-art" aria-hidden="true">
              <div className="mini-line w70" /><div className="mini-line w50" />
              <div className="mini-bar bar-1" /><div className="mini-bar bar-2" />
              <span className="choice-emoji">🖼️</span>
            </div>
            <h2>Image</h2>
            <p>Screenshots &amp; photos. PNG, JPG, JPEG.</p>
            <span className="choice-go">Let&apos;s go <ArrowIcon /></span>
          </Link>

          <Link href="/pdf" className="choice choice-pdf">
            <div className="choice-art" aria-hidden="true">
              <div className="mini-line w60" /><div className="mini-line w80" /><div className="mini-line w40" />
              <div className="mini-bar bar-1" /><div className="mini-bar bar-2" />
              <span className="choice-emoji">📄</span>
            </div>
            <h2>PDF</h2>
            <p>Multi-page documents, scanned or digital.</p>
            <span className="choice-go">Let&apos;s go <ArrowIcon /></span>
          </Link>
        </div>

        <p className="privacy-line"><LockIcon /> No accounts. No uploads. Your files never leave this device.</p>
      </section>
    </main>
  );
}
