import React from 'react';
import {
  Globe, Fingerprint, Film, Settings2,
  Library, ArrowLeftRight,
} from 'lucide-react';

// VideoDub Studio — chỉ giữ flow: Launchpad → Dub (chính) + Voice Library (Clone/Gallery)
const ITEMS = [
  { id: 'launchpad', label: 'Launchpad',     Icon: Globe,       accent: '#f3a5b6' },
  { id: 'dub',       label: 'Dub Video',     Icon: Film,        accent: '#fe8019' },
  { id: 'clone',     label: 'Voice Library', Icon: Fingerprint, accent: '#d3869b' },
  { id: 'gallery',   label: 'Gallery',       Icon: Library,     accent: '#b8bb26' },
];
const FOOTER_ITEMS = [
  { id: 'settings', label: 'Settings', Icon: Settings2, accent: '#fabd2f' },
];

function RailBtn({ active, Icon, label, accent, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rail-btn ${active ? 'active' : ''}`}
      style={{ '--rail-accent': accent }}
    >
      <Icon size={18} />
      <span className="rail-label">{label}</span>
    </button>
  );
}

export default function NavRail({ mode, setMode, side = 'left', onFlipSide }) {
  return (
    <aside className={`nav-rail rail-${side}`}>
      <div className="rail-top">
        {ITEMS.map((it) => (
          <RailBtn key={it.id} {...it} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
      </div>
      <div className="rail-bottom">
        {FOOTER_ITEMS.map((it) => (
          <RailBtn key={it.id} {...it} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
        <button
          onClick={onFlipSide}
          title={`Move rail to the ${side === 'left' ? 'right' : 'left'}`}
          aria-label="Flip rail side"
          className="rail-btn rail-flip"
        >
          <ArrowLeftRight size={15} />
        </button>
      </div>
    </aside>
  );
}
