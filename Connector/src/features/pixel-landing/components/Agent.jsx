/* Deplai agent — small autonomous deckhand unit. */

export default function Agent({ accent = "#00f0ff", className = "", style }) {
    return (
        <svg className={className} style={style} viewBox="0 0 60 78" fill="none" role="img" aria-label="Deplai agent unit">
            <style>{`
                .dl-agent-visor { animation: dl-agent-visor 3.8s steps(2) infinite; }
                @keyframes dl-agent-visor { 0%,100% { opacity: 1; } 92% { opacity: 1; } 96% { opacity: 0.2; } }
                .dl-agent-tip { animation: dl-agent-tip 1.6s steps(2) infinite; }
                @keyframes dl-agent-tip { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }
            `}</style>
            <ellipse cx="30" cy="74" rx="18" ry="3.5" fill="#000" opacity="0.35" />
            {/* treads */}
            <rect x="9" y="58" width="42" height="13" rx="6.5" fill="#141e2b" stroke="#3a5570" strokeWidth="1.6" />
            <circle cx="19" cy="64.5" r="3.4" fill="#0b101d" stroke="#4a6b82" strokeWidth="1.2" />
            <circle cx="30" cy="64.5" r="3.4" fill="#0b101d" stroke="#4a6b82" strokeWidth="1.2" />
            <circle cx="41" cy="64.5" r="3.4" fill="#0b101d" stroke="#4a6b82" strokeWidth="1.2" />
            {/* body */}
            <rect x="11" y="19" width="38" height="41" rx="5" fill="#2a3a4a" stroke="#4a6b82" strokeWidth="1.8" />
            <rect x="11" y="19" width="38" height="7" rx="3.5" fill="#1a2634" />
            {/* face */}
            <rect x="17" y="29" width="26" height="15" rx="2.5" fill="#05070a" stroke="#3a5570" strokeWidth="1" />
            <rect className="dl-agent-visor" x="20" y="33" width="20" height="6" rx="2" fill={accent} />
            {/* chest stripe + ports */}
            <rect x="17" y="49" width="18" height="4" fill={accent} />
            <rect x="39" y="49" width="4" height="4" fill="#ffb800" className="dl-agent-tip" />
            {/* arms */}
            <rect x="5" y="32" width="6" height="16" rx="3" fill="#3a5570" />
            <rect x="49" y="32" width="6" height="16" rx="3" fill="#3a5570" />
            {/* antenna */}
            <line x1="30" y1="19" x2="30" y2="9" stroke="#8ca0b3" strokeWidth="2" />
            <circle className="dl-agent-tip" cx="30" cy="7" r="3" fill={accent} />
        </svg>
    );
}
