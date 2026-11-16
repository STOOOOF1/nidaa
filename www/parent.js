// صفحة ولي الأمر: تسجيل النداء، سماعه، إرساله، وتكراره
(() => {
  const { rpc, errText, getPos, toast, fmtWindows, mmss } = VS;
  const $ = id => document.getElementById(id);
  const MAX_MS = 10000;
  const TWO_H = 2 * 60 * 60 * 1000;

  const code = (new URLSearchParams(location.search).get('s') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  let device = localStorage.getItem('vs_device');
  if (!device) {
    device = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    localStorage.setItem('vs_device', device);
  }

  let info = null, status = null, waitUntil = 0, busy = false;
  let rec = null;            // التسجيل قيد المعاينة {b64, mime, ms}
  let mr = null, stream = null, chunks = [], t0 = 0, recTick = null;

  // ---------- التسجيل المحفوظ محليًا (للاستماع فقط، يُحذف بعد ساعتين) ----------
  const recKey = 'vs_rec_' + code;
  function loadSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(recKey) || 'null');
      if (s && Date.now() - s.at < TWO_H) return s;
    } catch (e) {}
    localStorage.removeItem(recKey);
    return null;
  }
  function saveRec(r) {
    try { localStorage.setItem(recKey, JSON.stringify({ b64: r.b64, mime: r.mime, ms: r.ms, at: Date.now() })); } catch (e) {}
  }

  // ---------- مشغّل الصوت ----------
  const au = new Audio();
  let curP = null;
  function resetP() {
    if (!curP) return;
    curP.querySelector('.pbtn').classList.remove('on');
    curP.querySelector('.pfill').style.width = '0';
    curP = null;
  }
  au.onended = resetP;
  au.onpause = resetP;
  au.ontimeupdate = () => {
    if (!curP) return;
    const ms = +curP.dataset.ms || 1;
    curP.querySelector('.pfill').style.width = Math.min(100, au.currentTime * 1000 / ms * 100) + '%';
  };
  function bindPlayer(root, r) {
    root.dataset.ms = r.ms;
    root.querySelector('.ptime').textContent = mmss(Math.max(1, Math.round(r.ms / 1000)));
    root.querySelector('.pbtn').onclick = () => {
      if (curP === root && !au.paused) { au.pause(); return; }
      au.pause(); resetP();
      au.src = 'data:' + r.mime + ';base64,' + r.b64;
      curP = root;
      root.querySelector('.pbtn').classList.add('on');
      au.play().catch(() => { resetP(); toast('تعذّر تشغيل التسجيل على هذا الجهاز.', 'bad'); });
    };
  }

  // ---------- العرض ----------
  function waitLeft() { return Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)); }

  function render() {
    if (!info) return;
    const open = status ? status.is_open : info.is_open;
    const wait = waitLeft();
    const b = $('banner');
    if (status && status.blocked) {
      b.className = 'banner bad'; b.textContent = 'تم إيقاف النداء من هذا الجهاز من قبل الحارس.';
    } else if (open) {
      b.className = 'banner open'; b.textContent = 'النداء متاح الآن';
    } else {
      b.className = 'banner closed';
      const lines = info.mode === 'auto' ? fmtWindows(info.windows) : [];
      b.innerHTML = 'النداء مغلق الآن' + (lines.length ? '<small>أوقات النداء — ' + lines.join(' | ') + '</small>' : '<small>يُفتح في وقت الخروج</small>');
    }

    const has = status && status.has_call;
    $('lastCard').hidden = !has;
    if (has) {
      const ls = $('lastStatus');
      if (status.status === 'queued') {
        ls.className = 'status wait';
        ls.textContent = status.position <= 1 ? 'نداؤك التالي — يُبث الآن' : 'نداؤك في الطابور — ترتيبك ' + status.position;
      } else if (status.status === 'played') {
        ls.className = 'status ok'; ls.textContent = 'تم بث نداءك ✓';
      } else {
        ls.className = 'status bad'; ls.textContent = 'تم تخطي نداءك من قبل الحارس';
      }
      const saved = loadSaved();
      $('lastPlayer').hidden = !saved;
      if (saved && $('lastPlayer').dataset.at !== String(saved.at)) {
        $('lastPlayer').dataset.at = saved.at;
        bindPlayer($('lastPlayer'), saved);
      }
      const rb = $('repeatBtn');
      rb.disabled = busy || wait > 0 || !open || status.blocked;
      rb.textContent = wait > 0 ? 'كرّر النداء بعد ' + mmss(wait) : 'كرّر النداء';
    }

    $('recCard').hidden = !open || (status && status.blocked);
    $('recTitle').textContent = has ? 'تسجيل نداء جديد' : 'سجّل نداءك';
    const recording = mr && mr.state === 'recording';
    if (!recording && !rec) {
      $('micBtn').disabled = wait > 0;
      $('recHint').textContent = wait > 0
        ? 'يمكنك تسجيل نداء جديد بعد ' + mmss(wait)
        : 'اضغط الميكروفون وقل اسم ابنك بوضوح (10 ثوانٍ كحد أقصى)';
    }
    $('sendBtn').disabled = busy || wait > 0;
    $('sendBtn').textContent = busy ? 'جارٍ الإرسال…' : (wait > 0 ? 'الإرسال بعد ' + mmss(wait) : 'إرسال النداء');
  }

  async function refresh() {
    try {
      const r = await rpc('vs_call_status', { p_code: code, p_device: device });
      if (r.ok) { status = r; waitUntil = Date.now() + r.wait_s * 1000; render(); }
    } catch (e) {}
  }

  // ---------- التسجيل ----------
  function showStage(preview) {
    $('recStage').hidden = preview;
    $('previewStage').hidden = !preview;
  }

  async function startRec() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('متصفحك لا يدعم التسجيل الصوتي.', 'bad'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      toast('اسمح للصفحة باستخدام الميكروفون حتى تسجّل النداء.', 'bad'); return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : {});
    chunks = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = onRecStop;
    mr.start();
    t0 = performance.now();
    au.pause();
    $('micBtn').classList.add('rec');
    $('micIcon').hidden = true; $('stopIcon').hidden = false;
    $('timer').hidden = false;
    $('recHint').textContent = 'جارٍ التسجيل… اضغط للإيقاف';
    recTick = setInterval(() => {
      const el = performance.now() - t0;
      $('micBtn').style.setProperty('--p', Math.min(100, el / MAX_MS * 100));
      $('timer').textContent = mmss(el / 1000) + ' / 0:10';
      if (el >= MAX_MS) stopRec();
    }, 100);
  }

  function stopRec() {
    if (mr && mr.state === 'recording') mr.stop();
  }

  function onRecStop() {
    const ms = Math.min(MAX_MS, Math.round(performance.now() - t0));
    clearInterval(recTick);
    stream.getTracks().forEach(t => t.stop());
    $('micBtn').classList.remove('rec');
    $('micBtn').style.setProperty('--p', 0);
    $('micIcon').hidden = false; $('stopIcon').hidden = true;
    $('timer').hidden = true; $('timer').textContent = '0:00 / 0:10';
    const type = (mr.mimeType || 'audio/webm').split(';')[0];
    mr = null;
    if (ms < 700) { toast('التسجيل قصير جدًا. حاول مرة أخرى.', 'bad'); render(); return; }
    const fr = new FileReader();
    fr.onload = () => {
      rec = { b64: String(fr.result).split(',')[1], mime: type, ms };
      bindPlayer($('prevPlayer'), rec);
      showStage(true);
      render();
    };
    fr.readAsDataURL(new Blob(chunks, { type }));
  }

  // ---------- الإرسال والتكرار ----------
  async function withPos(fn) {
    if (busy) return;
    busy = true; render();
    try {
      let pos;
      try { pos = await getPos(); }
      catch (e) { toast(errText({ error: 'no_position' }), 'bad'); return; }
      const r = await fn(pos);
      if (r.ok) return true;
      if (r.error === 'cooldown') waitUntil = Date.now() + r.wait_s * 1000;
      toast(errText(r), 'bad');
    } catch (e) {
      toast(errText(null), 'bad');
    } finally {
      busy = false; render();
    }
  }

  async function send() {
    if (!rec) return;
    const r0 = rec;
    const ok = await withPos(pos => rpc('vs_call_submit', {
      p_code: code, p_device: device, p_lat: pos.lat, p_lng: pos.lng,
      p_audio: r0.b64, p_mime: r0.mime, p_duration_ms: r0.ms
    }));
    if (ok) {
      au.pause();
      saveRec(r0); rec = null; showStage(false);
      toast('تم إرسال نداءك', 'ok');
      await refresh();
    }
  }

  async function repeat() {
    const ok = await withPos(pos => rpc('vs_call_repeat', { p_code: code, p_device: device, p_lat: pos.lat, p_lng: pos.lng }));
    if (ok) { toast('تم تكرار النداء', 'ok'); await refresh(); }
  }

  // ---------- إدخال الرمز ومسح QR ----------
  function goCode(v) {
    const c = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (c.length !== 6) { toast('رمز النداء مكوّن من 6 خانات.', 'bad'); return; }
    location.href = 'index.html?s=' + c;
  }
  function codeFromText(t) {
    const m = /[?&]s=([A-Za-z0-9]{6})/.exec(t) || /^([A-Za-z0-9]{6})$/.exec(t.trim());
    return m ? m[1] : null;
  }
  async function scan() {
    const v = $('scanVideo');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      v.srcObject = s; v.hidden = false; await v.play();
      const det = new BarcodeDetector({ formats: ['qr_code'] });
      const loop = async () => {
        if (v.hidden) return;
        try {
          const found = await det.detect(v);
          const c = found.length && codeFromText(found[0].rawValue);
          if (c) { s.getTracks().forEach(t => t.stop()); goCode(c); return; }
        } catch (e) {}
        setTimeout(loop, 300);
      };
      loop();
    } catch (e) { toast('تعذّر فتح الكاميرا.', 'bad'); }
  }

  function showJoin() {
    $('join').hidden = false; $('main').hidden = true;
    $('scanBtn').hidden = !('BarcodeDetector' in window);
  }

  // ---------- البدء ----------
  async function init() {
    $('joinBtn').onclick = () => goCode($('codeInput').value);
    $('codeInput').onkeydown = e => { if (e.key === 'Enter') goCode($('codeInput').value); };
    $('scanBtn').onclick = scan;
    $('micBtn').onclick = () => (mr && mr.state === 'recording') ? stopRec() : startRec();
    $('redoBtn').onclick = () => { au.pause(); rec = null; showStage(false); render(); };
    $('sendBtn').onclick = send;
    $('repeatBtn').onclick = repeat;

    if (!VS.ready) { $('noconfig').hidden = false; showJoin(); return; }
    if (!code) { showJoin(); return; }
    try {
      const r = await rpc('vs_public_info', { p_code: code });
      if (!r.ok) { toast(errText(r), 'bad'); showJoin(); return; }
      info = r;
    } catch (e) { toast(errText(null), 'bad'); showJoin(); return; }
    $('main').hidden = false;
    render();
    await refresh();

    setInterval(render, 1000);
    // تحديث سريع أثناء انتظار البث، وأبطأ في غير ذلك
    let n = 0;
    setInterval(() => {
      n++;
      const queued = status && status.has_call && status.status === 'queued';
      if (document.hidden) return;
      if (queued ? n % 3 === 0 : n % 20 === 0) refresh();
    }, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
  init();
})();
