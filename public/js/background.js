/* ==========================================================================
   background.js — perilaku Marketplace Background System
   1. Partikel (jumlah mengikuti perangkat; mati saat reduced-motion)
   2. Parallax ringan (hanya desktop, hanya area hero)
   3. Intensitas cahaya mengikuti zona yang sedang terlihat
   ========================================================================== */
(() => {
  const root = document.querySelector('.marketplace-background');
  if (!root) return;

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width: 1025px)');
  const tablet = matchMedia('(min-width: 641px)');

  const seeded = (n) => {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };

  const currentTier = () => {
    if (reduceMotion.matches) return 'static';
    if (desktop.matches) return 'desktop';
    if (tablet.matches) return 'tablet';
    return 'mobile';
  };

  /* 1. Partikel
     ------------------------------------------------------------------------ */
  const PARTICLE_COUNT = { desktop: 14, tablet: 6, mobile: 0, static: 0 };
  const particleLayer = $q('.bg-particles');

  function $q(selector) {
    return root.querySelector(selector);
  }

  function buildParticles() {
    if (!particleLayer) return;
    particleLayer.textContent = '';

    const count = PARTICLE_COUNT[currentTier()];
    for (let i = 0; i < count; i++) {
      const dot = document.createElement('span');
      dot.className = 'bg-particle';
      dot.style.cssText = [
        `left:${(seeded(i + 1) * 100).toFixed(1)}%`,
        `top:${(35 + seeded(i + 9) * 65).toFixed(1)}%`,
        `--s:${(2 + seeded(i + 4) * 1.5).toFixed(1)}px`,
        `--o:${(.25 + seeded(i + 7) * .3).toFixed(2)}`,
        `--dx:${((seeded(i + 2) - .5) * 60).toFixed(0)}px`,
        `--t:${(46 + seeded(i + 3) * 44).toFixed(0)}s`,
        `--delay:-${(seeded(i + 5) * 60).toFixed(0)}s`,
      ].join(';');
      particleLayer.append(dot);
    }
  }

  /* 2. Parallax ringan
     ------------------------------------------------------------------------
     Elemen [data-parallax="faktor"] bergeser sebesar scrollY × faktor.
     Hanya aktif di desktop dan selama hero masih terlihat.
     ------------------------------------------------------------------------ */
  const layers = [...document.querySelectorAll('[data-parallax]')];
  let ticking = false;

  function applyParallax() {
    ticking = false;
    const y = scrollY;
    const active = currentTier() === 'desktop' && y < innerHeight * 1.4;

    layers.forEach((el) => {
      el.style.transform = active
        ? `translate3d(0, ${(y * parseFloat(el.dataset.parallax)).toFixed(1)}px, 0)`
        : '';
    });
  }

  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(applyParallax);
  }, { passive: true });

  /* 3. Intensitas cahaya per zona
     ------------------------------------------------------------------------ */
  const zones = document.querySelectorAll('.zone[data-zone]');
  if ('IntersectionObserver' in window && zones.length) {
    const zoneObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) root.dataset.zone = entry.target.dataset.zone;
      });
    }, { rootMargin: '-50% 0px -50% 0px' });

    zones.forEach((zone) => zoneObserver.observe(zone));
  }

  /* Mulai + sesuaikan saat ukuran layar / preferensi gerak berubah */
  const refresh = () => {
    buildParticles();
    applyParallax();
  };

  root.dataset.zone = root.dataset.zone || 'hero';
  refresh();
  [reduceMotion, desktop, tablet].forEach((mq) => mq.addEventListener('change', refresh));
})();
