// أدوات مشتركة بين صفحة ولي الأمر وشاشة الحارس
window.VS = (() => {
  const cfg = window.VS_CONFIG || {};
  const ready = !!(cfg.SUPABASE_URL && cfg.SUPABASE_KEY);

  async function rpc(fn, args) {
    if (!ready) throw new Error('not_configured');
    const r = await fetch(cfg.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.SUPABASE_KEY,
        Authorization: 'Bearer ' + cfg.SUPABASE_KEY
      },
      body: JSON.stringify(args || {})
    });
    if (!r.ok) throw new Error('http_' + r.status);
    return r.json();
  }

  const mmss = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  const ERR = {
    not_found: 'رمز النداء غير صحيح.',
    closed: 'النداء مغلق الآن. يُفتح في وقت الخروج فقط.',
    no_location: 'لم يُحدَّد موقع المدرسة بعد. أبلغ الحارس.',
    blocked: 'تم إيقاف النداء من هذا الجهاز من قبل الحارس.',
    no_position: 'تعذّر تحديد موقعك. فعّل خدمة الموقع (GPS) واسمح للصفحة باستخدامه.',
    queue_full: 'طابور النداء ممتلئ الآن. حاول بعد قليل.',
    bad_audio: 'التسجيل غير صالح. سجّل مرة أخرى.',
    no_recording: 'لا يوجد تسجيل سابق لتكراره. سجّل نداءً جديدًا.',
    bad_device: 'تعذّر تعريف الجهاز. أعد تحميل الصفحة.',
    bad_pin: 'الرقم السري غير صحيح.',
    locked: 'محاولات كثيرة خاطئة. حاول بعد 5 دقائق.',
    pin_short: 'الرقم السري يجب أن يكون 4 خانات على الأقل.',
    bad_windows: 'أوقات النداء غير صحيحة.',
    auth: 'انتهت صلاحية ربط هذا الجهاز. ادخل بالرمز والرقم السري من جديد.'
  };
  function errText(r) {
    if (!r) return 'تعذّر الاتصال. تحقق من الإنترنت.';
    if (r.error === 'too_far') {
      const d = r.distance_m >= 1000 ? (r.distance_m / 1000).toFixed(1) + ' كم' : r.distance_m + ' م';
      return 'أنت خارج محيط المدرسة (تبعد ' + d + '). النداء يعمل قرب المدرسة فقط.';
    }
    if (r.error === 'cooldown') return 'يمكنك النداء مرة أخرى بعد ' + mmss(r.wait_s) + '.';
    return ERR[r.error] || 'حدث خطأ غير متوقع.';
  }

  function getPos() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('no_geo'));
      navigator.geolocation.getCurrentPosition(
        p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
        e => rej(e),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    });
  }

  let toastTimer;
  function toast(msg, kind) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  function fmtWindows(windows) {
    return (windows || []).filter(w => w.days && w.days.length).map(w => {
      const d = w.days.slice().sort();
      const run = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
      const days = run ? DAYS[d[0]] + ' – ' + DAYS[d[d.length - 1]] : d.map(x => DAYS[x]).join('، ');
      return days + ': ' + w.from + ' – ' + w.to;
    });
  }

  function publicUrl(code) {
    const base = cfg.PUBLIC_URL || new URL('.', location.href).href;
    return base.replace(/\/?$/, '/') + '?s=' + code;
  }

  return { ready, rpc, errText, getPos, toast, fmtWindows, publicUrl, mmss, DAYS };
})();
