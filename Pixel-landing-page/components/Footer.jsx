const COLS = [
    {
        h: "Product",
        links: ["Agents", "Security", "Deployments", "Docs"],
    },
    {
        h: "Company",
        links: ["Blog", "Contact"],
    },
    {
        h: "Legal",
        links: ["Privacy", "Terms"],
    },
];

const BUBBLES = [
    { left: "12%", size: 5, delay: "0s" },
    { left: "14%", size: 3, delay: "-3s" },
    { left: "47%", size: 4, delay: "-5.5s" },
    { left: "49%", size: 6, delay: "-1.8s" },
    { left: "81%", size: 4, delay: "-7s" },
    { left: "84%", size: 3, delay: "-2.4s" },
];

const Shark = () => (
    <svg width="190" height="64" viewBox="0 0 200 64" fill="none">
        {/* body with forked tail, facing right (flipped by its swim animation) */}
        <path
            d="M10,36 C34,16 62,9 96,11 C118,13 138,18 158,26 L174,20 L165,30 L174,40 L156,35 C136,43 112,48 84,47 C58,46 30,44 10,36 Z"
            fill="#1c3049"
            stroke="#3a5c80"
            strokeWidth="1.6"
        />
        {/* dorsal fin */}
        <path d="M84,12 Q96,1 108,3 L100,13 Z" fill="#16283c" stroke="#3a5c80" strokeWidth="1.4" />
        {/* pectoral fin */}
        <path d="M84,46 L72,59 L94,47 Z" fill="#16283c" stroke="#3a5c80" strokeWidth="1.4" />
        {/* belly shade */}
        <path d="M14,36 C36,42 66,45 96,44 C120,43 140,39 154,34 C136,43 112,48 84,47 C58,46 30,44 14,36 Z" fill="#24405e" opacity="0.8" />
        {/* gills + eye */}
        <line x1="42" y1="24" x2="42" y2="34" stroke="#0a1420" strokeWidth="1.6" />
        <line x1="48" y1="24" x2="48" y2="35" stroke="#0a1420" strokeWidth="1.6" />
        <line x1="54" y1="25" x2="54" y2="35" stroke="#0a1420" strokeWidth="1.6" />
        <circle cx="30" cy="28" r="2.6" fill="#05070a" />
        <circle cx="29" cy="27" r="0.9" fill="#8ca0b3" />
    </svg>
);

const Clownfish = () => (
    <svg width="58" height="32" viewBox="0 0 60 32" fill="none">
        {/* tail + body, facing right */}
        <polygon points="3,16 15,7 15,25" fill="#ff8a3d" stroke="#c85f14" strokeWidth="1.2" />
        <ellipse cx="33" cy="16" rx="20" ry="11" fill="#ff8a3d" stroke="#c85f14" strokeWidth="1.4" />
        {/* dorsal + belly fins */}
        <path d="M22,6 Q33,-1 45,7 L43,9 Q33,3 24,8 Z" fill="#e06f1c" />
        <path d="M26,26 Q33,31 40,26 L38,24 Q33,27 28,24 Z" fill="#e06f1c" />
        {/* three white bands */}
        <path d="M41,6.5 Q45,16 41,25.5 L46.5,24.5 Q50,16 46.5,7.5 Z" fill="#f4f0ea" stroke="#2a323d" strokeWidth="1" />
        <path d="M26,6 Q30,16 26,26 L31.5,25.5 Q35,16 31.5,6.5 Z" fill="#f4f0ea" stroke="#2a323d" strokeWidth="1" />
        <path d="M15,9 Q18,16 15,23 L18.5,22.5 Q21,16 18.5,9.5 Z" fill="#f4f0ea" stroke="#2a323d" strokeWidth="0.9" />
        {/* eye */}
        <circle cx="47" cy="13" r="2.6" fill="#f4f0ea" />
        <circle cx="47.6" cy="13.4" r="1.4" fill="#05070a" />
    </svg>
);

const SmallFish = ({ w = 30 }) => (
    <svg width={w} height={(w * 14) / 30} viewBox="0 0 30 14" fill="none">
        <polygon points="1,7 9,2 9,12" fill="#3a6284" />
        <ellipse cx="17" cy="7" rx="11" ry="5.5" fill="#4a7ba6" />
        <ellipse cx="17" cy="8.6" rx="9" ry="2.8" fill="#35597c" />
        <circle cx="24" cy="6" r="1.3" fill="#05070a" />
    </svg>
);

const Jellyfish = () => (
    <svg width="42" height="54" viewBox="0 0 42 54" fill="none">
        <path d="M7,22 a14,14 0 0 1 28,0 z" fill="#7b61ff" opacity="0.8" />
        <path d="M7,22 q3,4 7,0 q3,4 7,0 q3,4 7,0 q3,4 7,0" stroke="#8f76ff" strokeWidth="2" fill="none" />
        <g stroke="#7b61ff" strokeWidth="2" strokeLinecap="round" opacity="0.7">
            <path d="M13,26 q-3,10 1,18" />
            <path d="M21,27 q0,10 -2,21" />
            <path d="M29,26 q3,10 0,19" />
        </g>
    </svg>
);

export default function Footer() {
    return (
        <footer className="dl-footer" data-testid="site-footer">
            {/* deep sea layer */}
            <div className="dl-sea" aria-hidden="true">
                <div className="dl-rays" />
                <div className="dl-rays r2" />
                {BUBBLES.map((b, i) => (
                    <i key={i} className="dl-bubble" style={{ left: b.left, width: b.size, height: b.size, animationDelay: b.delay }} />
                ))}
                <div className="dl-shark">
                    <Shark />
                </div>
                <div className="dl-nemo">
                    <Clownfish />
                </div>
                <div className="dl-smlfish f1">
                    <SmallFish />
                </div>
                <div className="dl-smlfish f2">
                    <SmallFish w={22} />
                </div>
                <div className="dl-jelly">
                    <Jellyfish />
                </div>
            </div>

            <div className="dl-footer-inner">
                <div className="dl-footer-brand">
                    <div className="word">
                        DEPL<em>AI</em>
                    </div>
                    <p>The autonomous software shipping company. One voyage: your code to production.</p>
                    <div className="dl-footer-coords">
                        51.9225° N — 4.4792° E
                        <br />
                        Depth -3800m · Pressure nominal
                    </div>
                </div>
                {COLS.map((c) => (
                    <div className="dl-footer-col" key={c.h}>
                        <h4>{c.h}</h4>
                        {c.links.map((l) => (
                            <a key={l} href="#port" data-testid={`footer-link-${l.toLowerCase()}`}>
                                {l}
                            </a>
                        ))}
                    </div>
                ))}
            </div>

            {/* sea floor */}
            <div className="dl-seafloor" aria-hidden="true">
                <svg viewBox="0 0 1600 160" preserveAspectRatio="none" width="100%" height="100%">
                    <g fill="#0a1524">
                        <polygon points="0,160 0,110 90,88 200,112 300,96 380,118 480,104 560,160" />
                        <polygon points="1020,160 1080,104 1180,88 1290,116 1380,98 1480,120 1600,100 1600,160" />
                        <polygon points="560,160 640,126 760,138 860,124 960,142 1040,160" />
                    </g>
                    <g fill="#060d18">
                        <polygon points="0,160 0,134 140,120 260,140 380,128 500,144 620,160" />
                        <polygon points="900,160 1000,132 1120,148 1240,130 1380,146 1600,126 1600,160" />
                    </g>
                    {/* sunken container from an old deploy */}
                    <g transform="translate(690,108) rotate(-7)">
                        <rect width="110" height="40" fill="#8f6600" stroke="#5c4300" strokeWidth="2" />
                        {[18, 34, 50, 66, 82, 96].map((x) => (
                            <line key={x} x1={x} y1="4" x2={x} y2="36" stroke="#5c4300" strokeWidth="1.4" opacity="0.6" />
                        ))}
                        <text x="55" y="24" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="9" fill="#2a1e00" letterSpacing="1">
                            DPL-0007
                        </text>
                    </g>
                    {/* seaweed */}
                    <g stroke="#1d4a44" strokeWidth="5" strokeLinecap="round" fill="none">
                        <path className="dl-weed" d="M150,132 q-8,-22 2,-42 q8,-18 -2,-34" />
                        <path className="dl-weed w2" d="M178,136 q8,-20 -2,-38" />
                        <path className="dl-weed" d="M1330,128 q-8,-24 2,-44 q8,-16 -2,-32" />
                        <path className="dl-weed w2" d="M1360,134 q8,-18 -2,-36" />
                    </g>
                </svg>
            </div>

            <div className="dl-footer-bar">
                <span>© 2026 Deplai Industries</span>
                <div className="dl-footer-status" data-testid="footer-status">
                    <span>
                        <i />
                        Fleet nominal
                    </span>
                    <span>
                        <i />
                        All ports connected
                    </span>
                    <span>
                        <i />
                        Uptime 99.99%
                    </span>
                </div>
                <span>Berth 07 · Ready</span>
            </div>
        </footer>
    );
}
