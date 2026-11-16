// شاشة الحارس: تعرض QR وتبث النداءات واحدًا بعد الآخر بدون تداخل
(() => {
  const { rpc, errText, getPos, toast, publicUrl, DAYS } = VS;
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let st = null;
  try { st = JSON.parse(localStorage.getItem('vs_station') || 'null'); } catch (e) {}
  const auth = () => ({ p_code: st.code, p_token: st.token });

  let data = null, started = false, paused = false, busy = false, current = null;
  let actx = null, chain = null, gain = null, stopCurrent = null, skipFlag = false;
  let chimeOn = localStorage.getItem('vs_chime') !== '0';
  const done = new Set();          // نداءات بُثّت على هذا الجهاز (حماية من التكرار عند انقطاع الشبكة)
  const pendingMarks = new Map();  // تحديثات حالة لم تصل للخادم بعد

  // ---------- الصوت ----------
  function initAudio() {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 6;
    gain = actx.createGain();
    gain.gain.value = (+localStorage.getItem('vs_vol') || 100) / 100;
    comp.connect(gain); gain.connect(actx.destination);
    chain = comp;
  }

  function chime() {
    return new Promise(res => {
      const t = actx.currentTime;
      [[880, 0], [660, 0.28]].forEach(([f, d]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t + d);
        g.gain.linearRampToValueAtTime(0.5, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.6);
        o.connect(g); g.connect(gain);
        o.start(t + d); o.stop(t + d + 0.65);
      });
      setTimeout(res, 1000);
    });
  }

  const fallbackEl = new Audio();
  async function playAudio(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let buf = null;
    try { buf = await actx.decodeAudioData(bytes.buffer); } catch (e) {}
    if (buf) {
      await new Promise(res => {
        const src = actx.createBufferSource();
        src.buffer = buf; src.connect(chain);
        src.onended = res;
        stopCurrent = () => { try { src.stop(); } catch (e) {} };
        src.start();
      });
    } else {
      // صيغة لا يفكّها هذا المتصفح عبر WebAudio — نجرب المشغّل العادي
      await new Promise((res, rej) => {
        fallbackEl.src = 'data:' + mime + ';base64,' + b64;
        fallbackEl.onended = res;
        fallbackEl.onerror = () => rej(new Error('decode'));
        stopCurrent = () => { fallbackEl.pause(); res(); };
        fallbackEl.play().catch(rej);
      });
    }
    stopCurrent = null;
  }

  // ---------- الطابور ----------
  async function mark(id, status) {
    pendingMarks.set(id, status);
    await flushMarks();
  }
  async function flushMarks() {
    for (const [id, status] of [...pendingMarks]) {
      try {
        const r = await rpc('vs_station_mark', { ...auth(), p_id: id, p_status: status });
        if (r.ok) pendingMarks.delete(id);
      } catch (e) { return; }
    }
  }

  async function pump() {
    if (!started || paused || busy || !data) return;
    const c = data.queue.find(x => !done.has(x.id));
    if (!c) return;
    busy = true; skipFlag = false;
    let ok = false;
    try {
      const a = await rpc('vs_station_audio', { ...auth(), p_id: c.id });
      if (a.ok) {
        if (actx.state !== 'running') await actx.resume();
        current = c; render();
        if (chimeOn) await chime();
        if (!skipFlag) await playAudio(a.audio, a.mime);
        ok = !skipFlag;
      }
    } catch (e) {
      if (!current) { busy = false; return; }   // فشل الجلب بسبب الشبكة: يُعاد لاحقًا
    }
    done.add(c.id);
    current = null;
    data.queue = data.queue.filter(x => x.id !== c.id);
    render();
    await mark(c.id, ok ? 'played' : 'skipped');
    await sleep(800);                            // فاصل قصير بين نداء وآخر
    busy = false;
    poll(true);
  }

  let pollTimer = null;
  async function poll(now) {
    clearTimeout(pollTimer);
    if (!st) return;
    try {
      await flushMarks();
      const r = await rpc('vs_station_poll', auth());
      if (!r.ok) {
        if (r.error === 'auth') { toast(errText(r), 'bad'); logout(); return; }
      } else {
        // لا نعيد إدراج نداء ما زال تحديث حالته معلقًا
        r.queue = r.queue.filter(x => !pendingMarks.has(x.id));
        data = r; $('offline').hidden = true;
        render(); pump();
      }
    } catch (e) { $('offline').hidden = false; }
    pollTimer = setTimeout(poll, 2500);
  }

  // ---------- العرض ----------
  function render() {
    if (!data) return;
    const s = data.station, pill = $('pill');
    if (!s.has_location) { pill.className = 'pill bad'; pill.textContent = 'حدّد موقع المدرسة من الإعدادات'; }
    else if (s.is_open) { pill.className = 'pill open'; pill.textContent = 'النداء مفتوح'; }
    else { pill.className = 'pill closed'; pill.textContent = 'النداء مغلق'; }

    const n = data.queue.filter(x => !done.has(x.id) && (!current || x.id !== current.id)).length;
    $('nowCard').classList.toggle('live', !!current);
    $('nowTxt').textContent = current ? 'يُبث نداء الآن' : (paused ? 'البث متوقف مؤقتًا' : 'بانتظار النداءات');
    $('qCount').textContent = n ? 'في الطابور: ' + n + (n > 10 ? ' نداءً' : n > 2 ? ' نداءات' : n === 2 ? ' (نداءان)' : ' (نداء واحد)') : 'لا يوجد نداءات في الطابور';
    $('skipBtn').disabled = !current;
    $('pauseBtn').textContent = paused ? 'متابعة البث' : 'إيقاف مؤقت';
    $('chimeBtn').textContent = 'نغمة التنبيه: ' + (chimeOn ? 'مفعّلة' : 'متوقفة');
    $('unblockBtn').hidden = !data.blocked;
    $('unblockBtn').textContent = 'إلغاء حظر الأجهزة (' + data.blocked + ')';

    const ul = $('recent');
    if (!data.recent.length) { ul.innerHTML = '<li class="muted">لا يوجد نداءات بعد</li>'; return; }
    ul.innerHTML = '';
    data.recent.forEach(c => {
      const li = document.createElement('li');
      const time = new Date(c.at).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
      li.innerHTML = '<span class="tag ' + c.status + '">' + (c.status === 'played' ? 'تم البث' : 'تم التخطي') + '</span>' +
        '<span class="grow">' + time + ' — ' + Math.max(1, Math.round(c.duration_ms / 1000)) + ' ث</span>';
      const again = document.createElement('button');
      again.className = 'btn sm'; again.textContent = 'إعادة البث';
      again.onclick = async () => { done.delete(c.id); await mark(c.id, 'queued'); poll(true); };
      const block = document.createElement('button');
      block.className = 'btn sm danger'; block.textContent = 'حظر الجهاز';
      block.onclick = async () => {
        if (!confirm('حظر هذا الجهاز من النداء لمدة 24 ساعة؟')) return;
        try { await rpc('vs_station_block', { ...auth(), p_id: c.id }); toast('تم حظر الجهاز', 'ok'); poll(true); }
        catch (e) { toast(errText(null), 'bad'); }
      };
      li.append(again, block);
      ul.append(li);
    });
  }

  function renderQr() {
    const url = publicUrl(st.code);
    const q = qrcode(0, 'M');
    q.addData(url); q.make();
    $('qr').innerHTML = q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    $('codeTxt').textContent = st.code;
    $('urlTxt').textContent = url;
  }

  // ---------- إبقاء الشاشة مضاءة ----------
  let wake = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && started) { keepAwake(); poll(true); }
  });

  // ---------- الدخول ----------
  function showLive() {
    $('setup').hidden = true; $('live').hidden = false;
    renderQr(); poll(true);
  }
  function logout() {
    localStorage.removeItem('vs_station'); st = null;
    clearTimeout(pollTimer);
    if ($('dlg').open) $('dlg').close();
    $('live').hidden = true; $('setup').hidden = false;
  }

  async function create() {
    const pin = $('newPin').value.trim();
    if (pin.length < 4) { toast(errText({ error: 'pin_short' }), 'bad'); return; }
    $('createBtn').disabled = true;
    let pos = null;
    try { pos = await getPos(); } catch (e) {}
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Riyadh';
      const r = await rpc('vs_station_create', { p_pin: pin, p_lat: pos && pos.lat, p_lng: pos && pos.lng, p_tz: tz });
      if (!r.ok) { toast(errText(r), 'bad'); return; }
      st = { code: r.code, token: r.token };
      localStorage.setItem('vs_station', JSON.stringify(st));
      showLive();
      toast(pos ? 'تم الإنشاء وحُفظ موقع المدرسة' : 'تم الإنشاء. حدّد موقع المدرسة من الإعدادات.', pos ? 'ok' : 'bad');
    } catch (e) { toast(errText(null), 'bad'); }
    finally { $('createBtn').disabled = false; }
  }

  async function login() {
    try {
      const r = await rpc('vs_station_login', { p_code: $('inCode').value, p_pin: $('inPin').value.trim() });
      if (!r.ok) { toast(errText(r), 'bad'); return; }
      st = { code: r.code, token: r.token };
      localStorage.setItem('vs_station', JSON.stringify(st));
      $('inPin').value = '';
      showLive();
    } catch (e) { toast(errText(null), 'bad'); }
  }

  // ---------- الإعدادات ----------
  let admPin = '';
  function winRow(w) {
    const d = document.createElement('div');
    d.className = 'win';
    d.innerHTML = '<div class="days">' + DAYS.map((n, i) =>
      '<label title="' + n + '"><input type="checkbox" value="' + i + '"' + (w.days.includes(i) ? ' checked' : '') + '>' + 'حنثرخجس'[i] + '</label>').join('') + '</div>' +
      '<div class="row"><span>من</span><input type="time" class="wf" value="' + w.from + '"><span>إلى</span><input type="time" class="wt" value="' + w.to + '">' +
      '<button class="btn sm danger" style="flex:none">حذف</button></div>';
    d.querySelector('button').onclick = () => d.remove();
    return d;
  }
  function fillSettings(s) {
    document.querySelectorAll('input[name=mode]').forEach(r => { r.checked = r.value === s.mode; });
    $('wins').innerHTML = '';
    s.windows.forEach(w => $('wins').append(winRow(w)));
    $('lat').value = s.lat ?? ''; $('lng').value = s.lng ?? '';
    $('locTxt').textContent = s.has_location ? 'الموقع محفوظ.' : 'لم يُحدَّد الموقع بعد — النداء لن يعمل قبل تحديده.';
    $('radius').value = s.radius_m; showRadius();
    $('pinNew').value = '';
  }
  function showRadius() {
    const v = +$('radius').value;
    $('radiusTxt').textContent = v >= 1000 ? (v / 1000) + ' كم' : v + ' م';
  }
  async function admGo() {
    try {
      const r = await rpc('vs_station_login', { p_code: st.code, p_pin: $('admPin').value.trim() });
      if (!r.ok) { toast(errText(r), 'bad'); return; }
      admPin = $('admPin').value.trim(); $('admPin').value = '';
      fillSettings(r.station);
      $('pinStep').hidden = true; $('setStep').hidden = false;
    } catch (e) { toast(errText(null), 'bad'); }
  }
  async function save() {
    const windows = [...document.querySelectorAll('#wins .win')].map(d => ({
      days: [...d.querySelectorAll('.days input:checked')].map(i => +i.value),
      from: d.querySelector('.wf').value, to: d.querySelector('.wt').value
    }));
    if (windows.some(w => !w.from || !w.to || w.from >= w.to || !w.days.length)) {
      toast('راجع أوقات النداء: اختر الأيام ووقت البداية قبل النهاية.', 'bad'); return;
    }
    const p = {
      mode: document.querySelector('input[name=mode]:checked').value,
      windows, radius_m: +$('radius').value
    };
    const lat = parseFloat($('lat').value), lng = parseFloat($('lng').value);
    if (!isNaN(lat) && !isNaN(lng)) {
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) { toast('إحداثيات الموقع غير صحيحة.', 'bad'); return; }
      p.lat = lat; p.lng = lng;
    }
    const np = $('pinNew').value.trim();
    if (np) p.new_pin = np;
    try {
      const r = await rpc('vs_station_update', { p_code: st.code, p_pin: admPin, p });
      if (!r.ok) { toast(errText(r), 'bad'); return; }
      if (np) admPin = np;
      toast('تم الحفظ', 'ok');
      $('dlg').close(); poll(true);
    } catch (e) { toast(errText(null), 'bad'); }
  }

  // ---------- الربط ----------
  $('createBtn').onclick = create;
  $('loginBtn').onclick = login;
  $('startBtn').onclick = async () => {
    initAudio();
    await actx.resume();
    started = true;
    $('unlock').hidden = true;
    keepAwake();
    chime();
    pump();
  };
  $('pauseBtn').onclick = () => { paused = !paused; render(); pump(); };
  $('skipBtn').onclick = () => { skipFlag = true; if (stopCurrent) stopCurrent(); };
  $('testBtn').onclick = () => { if (actx) chime(); };
  $('chimeBtn').onclick = () => { chimeOn = !chimeOn; localStorage.setItem('vs_chime', chimeOn ? '1' : '0'); render(); };
  $('vol').value = +localStorage.getItem('vs_vol') || 100;
  $('vol').oninput = () => { localStorage.setItem('vs_vol', $('vol').value); if (gain) gain.gain.value = $('vol').value / 100; };
  $('unblockBtn').onclick = async () => {
    try { await rpc('vs_station_unblock_all', auth()); toast('تم إلغاء الحظر', 'ok'); poll(true); } catch (e) { toast(errText(null), 'bad'); }
  };
  $('shareBtn').onclick = async () => {
    const url = publicUrl(st.code);
    const text = 'نداء الطلاب — افتح الرابط عند وصولك للمدرسة ونادِ ابنك بصوتك:';
    try {
      if (navigator.share) await navigator.share({ title: 'نداء الطلاب', text, url });
      else { await navigator.clipboard.writeText(text + '\n' + url); toast('تم نسخ الرابط', 'ok'); }
    } catch (e) {}
  };
  $('printBtn').onclick = () => window.print();
  $('settingsBtn').onclick = () => {
    $('pinStep').hidden = false; $('setStep').hidden = true; $('admPin').value = '';
    $('dlg').showModal();
  };
  document.querySelectorAll('.dlgClose').forEach(b => { b.onclick = () => $('dlg').close(); });
  $('admGo').onclick = admGo;
  $('admPin').onkeydown = e => { if (e.key === 'Enter') admGo(); };
  $('addWin').onclick = () => $('wins').append(winRow({ days: [0, 1, 2, 3, 4], from: '12:00', to: '13:30' }));
  $('radius').oninput = showRadius;
  $('locBtn').onclick = async () => {
    try {
      const p = await getPos();
      $('lat').value = p.lat.toFixed(6); $('lng').value = p.lng.toFixed(6);
      $('locTxt').textContent = 'تم التقاط الموقع (الدقة ±' + p.acc + ' م). اضغط حفظ.';
    } catch (e) { toast(errText({ error: 'no_position' }), 'bad'); }
  };
  $('saveBtn').onclick = save;
  $('logoutBtn').onclick = () => { if (confirm('فصل هذا الجهاز عن نقطة النداء؟ يمكنك الدخول لاحقًا بالرمز والرقم السري.')) logout(); };

  if (!VS.ready) $('noconfig').hidden = false;
  if (st && st.code && st.token && VS.ready) showLive(); else $('setup').hidden = false;
})();
