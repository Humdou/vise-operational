'use client';

import dynamic from 'next/dynamic';

const GameApp = dynamic(() => import('../components/GameApp'), {
  ssr: false,
  loading: () => (
    <div className="loading-screen">
      <div className="loading-title">VISE OPERATIONAL</div>
      <div className="loading-sub">Chargement…</div>
    </div>
  ),
});

export default function Page() {
  return <GameApp />;
}
