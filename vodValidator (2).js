/**
 * Copyright (C) NPAW - All Rights Reserved
 * This source code is protected under international copyright law.
 *
 * @description: VOD single-asset validator — v9
 *               FASES: OPEN → INTRO → STEADY → GRACE
 *
 * NOVO NA v9 (montagem de abertura escura — Proposta B):
 *   Sintoma: título abre com cartelas de patrocínio (com movimento) seguidas de
 *   FADES PRETOS longos e repetidos. A Fase 2A emerge no 1º respiro (~5s) e a
 *   montagem escura cai inteira no STEADY: 4 episódios TRUE_BLACK de ~3s
 *   (12.033ms = 40,1% > 35%), com áudio fluindo -> reprovava como PLAYBACK_BLACK.
 *
 *   Correção: quando o ÚNICO gatilho de hard-fail é o ACÚMULO de preto (>35%) e o
 *   padrão é INTERMITENTE-RECUPERÁVEL (>= darkMontageMinEpisodes episódios, nenhum
 *   longo, não termina em preto, áudio contínuo, trecho limpo saudável e razão de
 *   preto < darkMontageMaxBlackRatio), o veredito deixa de ser ERRO e passa a
 *   DARK_OPENING_REVIEW (revisão visual). Vídeo morto (1 bloco contínuo, término
 *   em preto, sem áudio, ou preto > teto de segurança) continua reprovando.
 *
 * NOVO NA v8 (abertura escura / preto recuperável — Proposta A):
 *   Sintoma: filme com abertura mais longa que o normal, cujo respiro inicial
 *   de movimento (~5s) fez a Fase 2A declarar "emergiu" cedo. As cenas escuras
 *   seguintes caíram no STEADY como TRUE_BLACK (2.840ms + 2.320ms = 17,2% > 15%),
 *   com áudio fluindo, e o veredito caiu em BLACK_WITH_AUDIO_REVIEW.
 *
 *   Correção: no ramo de preto-com-áudio, antes de marcar REVISAR, se TODOS os
 *   episódios de preto foram curtos (< reviewBlackEpisodeMs), SE RECUPERARAM
 *   (não terminou em preto), há um trecho limpo saudável (>= minSteadyCleanGapMs)
 *   e o áudio é sólido (silêncio < darkOpeningMaxSilenceRatio), o veredito passa
 *   a OK_DARK_OPENING (abertura escura/fade legítimo). Safeguards intactos:
 *   preto que PERSISTE (grace), episódio longo, acúmulo alto ou sem áudio
 *   continuam reprovando como PLAYBACK_BLACK.
 *
 * PROBLEMA RESOLVIDO (log debug.1785627270232):
 *   Todos os critérios passavam (preto 10,9%<15%, freeze 16,6%<20%, silêncio
 *   4,5%<25%, trecho limpo 15.007ms>5.000ms, episódio 4.990ms<10.000ms) e mesmo
 *   assim o teste reprovou — porque a janela de 30s fechou EXATAMENTE durante um
 *   artefato (25012+4990 = 30002, diferença zero).
 *
 *   Como os artefatos cobrem ~41% da janela em conteúdo normal, ~4 em cada 10
 *   execuções reprovavam por pura coincidência de onde o corte caía.
 *   O fim da janela é um instante ARBITRÁRIO — não é evidência de falha.
 *
 * SOLUÇÃO — FASE 3 (GRACE / CONFIRMAÇÃO):
 *   Se a janela termina com artefato em curso, o script NÃO conclui nada ainda.
 *   Continua observando até `endArtifactGraceMs`:
 *     - artefato RESOLVE  -> era cena/plano estático. Não conta como "terminou
 *                            em falha". O playback é julgado pelo resto.
 *     - artefato PERSISTE -> falha confirmada, agora com duração real medida
 *                            (não mais truncada pelo corte).
 *
 *   Assim a decisão passa a depender do CONTEÚDO, não de onde a janela caiu.
 *
 * Mantém da v6.1: filtro de ruído 24fps, TRUE_BLACK×DARK_SCENE, tolerância a
 * intro, abertura silenciosa, longestNonCriticalGap, sonda de mute, evidências.
 *
 * Sem playbackValidator. Sem pngjs. Só frameAnalyzers.freezes + audioAnalyzers.Silence.
 * 5 / 100 / 1000
 */

const path = require('path');
let fs = null;
try { fs = require('fs'); } catch (_) { fs = null; }

const mediaOpen = require('../../helpers/mediaOpen');
const rcu = require('../../helpers/rcu');
const results = require('../../helpers/results');
const config = require('../../config.json');

const testFile = path.parse(__filename).name;

// ---------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------
const VOD_CFG = Object.assign({
    navigationSequence: [
        { key: 'home', delay: 5000, label: 'Home' },
        { key: 'right', delay: 2500, label: 'Move right' },
        { key: 'down', delay: 2500, label: 'Move down 1/4' },
        { key: 'down', delay: 2500, label: 'Move down 2/4' },
        { key: 'down', delay: 2500, label: 'Move down 3/4' },
        { key: 'down', delay: 2700, label: 'Move down 4/4' },
        { key: 'down', delay: 2700, label: 'Move down 5/5' },
        { key: 'down', delay: 2700, label: 'Move down 6/6' },
        { key: 'right', delay: 2700, label: 'Move right' },
        { key: 'right', delay: 7000, label: 'Move right' }
    ],
    triggerStep: { key: 'ok', label: 'PLAY' },

    // ---------- FASE 1: abertura ----------
    openTimeoutMs: 40000,
    maxTimeToPlayMs: 20000,
    maxStartupBlackMs: 45000,          // com áudio confirmado
    maxStartupBlackNoAudioMs: 20000,   // sem áudio
    silentOpeningVideoMs: 8000,
    maxTimeToAudioMs: 40000,

    // ---------- FASE 2A: intro / emergência ----------
    introToleranceEnabled: true,
    maxIntroWaitMs: 90000,
    minEmergenceCleanMs: 5000,
    introNoAudioAbortMs: 25000,
    introEvidenceEveryMs: 15000,
    introBlacknessVarianceMin: 5,

    // ---------- FASE 2B: playback ----------
    steadyWindowMs: 30000,
    steadySettleMs: 1500,

    minArtifactDurationMs: 1000,
    mergeGapMs: 100,

    maxSteadyTrueBlackRatio: 0.15,
    maxSteadyFreezeRatio: 0.20,
    maxSteadySilenceRatio: 0.25,
    minSteadyCleanGapMs: 5000,
    trueBlackThreshold: 99,

    // ---------- FASE 3: GRACE (confirmação de borda) ----------
    // O fim da janela é arbitrário. Se um artefato está em curso no corte,
    // observa mais um pouco para saber se era cena ou falha real.
    endArtifactGraceMs: 15000,
    graceEvidenceEveryMs: 5000,
    // Fallback quando não há como observar (analisador indisponível):
    // só considera "terminou em falha" se o artefato já for longo o bastante.
    minConclusiveEndArtifactMs: 8000,

    blackWithAudioPolicy: 'inconclusive',
    saturationCoverageRatio: 0.95,
    postEmergenceBlackFailMs: 10000,
    postEmergenceFreezeFailMs: 10000,
    postEmergenceBlackHardRatio: 0.35,

    // ---------- v8: tolerância a abertura escura (preto recuperável) ----------
    // Preto real COM áudio contínuo que se RECUPERA (episódios curtos, sem
    // terminar em preto e com um bom trecho limpo por perto) é compatível com
    // fade/abertura escura de filme — não deve virar REVISAR nem falha.
    darkOpeningToleranceEnabled: true,
    reviewBlackEpisodeMs: 5000,        // maior episódio de preto ainda aceitável
    darkOpeningMaxSilenceRatio: 0.10,  // áudio precisa estar sólido (< 10% silêncio)

    // ---------- v9: montagem de abertura escura (patrocínios + fades longos) ----------
    // Alguns títulos abrem com cartelas de patrocínio intercaladas por fades pretos
    // LONGOS. A Fase 2A emerge no 1º respiro de movimento (~5s) e a montagem escura
    // cai inteira no STEADY, acumulando muito preto (> 35%) e reprovando por engano.
    // Se o preto é INTERMITENTE (vários episódios que SE RECUPERAM), com áudio
    // contínuo e um bom trecho limpo, NÃO é vídeo morto: em vez de reprovar direto,
    // o caso vai para REVISÃO VISUAL (conferência de PNGs).
    darkMontageReviewEnabled: true,
    darkMontageMinEpisodes: 3,         // nº mínimo de episódios de preto para caracterizar montagem
    darkMontageMaxBlackRatio: 0.55,    // teto de segurança: acima disso, reprova (quase tudo preto)

    // ---------- evidência ----------
    captureEvidence: true,
    evidenceDir: (config.vod && config.vod.evidenceDir) || '.',
    evidenceOnArtifactMs: 3000,
    maxEvidenceShots: 14,
    filmstripEverySteadyMs: 10000,

    ensureAudio: true,
    preTriggerSettleMs: 1500,

    masks: [],
    minTimeInMotion: 1500,
    minFreezeDuration: 1000,
    minBlackBlackness: 75,

    audioMuteProbe: true,
    audioMuteProbeTimeoutMs: 6000,
    treatNoSilenceEventsAsAudio: true,

    publishToLogstash: false,
    assetTitle: 'VOD single content validation'
}, (config.vod || {}));

const sleep = global.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
const log = global.logger || console;

// ---------------------------------------------------------------
// Results
// ---------------------------------------------------------------
const vodResults = {
    passed: false,
    data: [
        { type: 'table', title: 'VOD Playback Validation', data: [] },
        { type: 'table', title: 'VOD Intro / Emergence', data: [] },
        { type: 'table', title: 'VOD Steady Artifacts (filtrados)', data: [] },
        { type: 'table', title: 'VOD Raw Events (auditoria)', data: [] },
        { type: 'table', title: 'VOD Evidence', data: [] }
    ],
    index: 0,
    add: function (row) {
        this.index++;
        this.data[0].data.push(Object.assign({ index: this.index }, row));
        const r = (global.input && input.resultsRetention) ? input.resultsRetention : 100;
        this.data[0].data = this.data[0].data.slice(-r);
    },
    addIntro: function (row) { this.data[1].data.push(row); },
    addArtifact: function (row) { this.data[2].data.push(row); },
    addRaw: function (row) { this.data[3].data.push(row); },
    addEvidence: function (row) { this.data[4].data.push(row); }
};

// ---------------------------------------------------------------
// Analisadores nativos
// ---------------------------------------------------------------
function getFreezeAnalyzer() {
    try {
        if (typeof devices === 'undefined') return null;
        const h = devices.STB0 && devices.STB0.videoGrabbers && devices.STB0.videoGrabbers.HDMI;
        return (h && h.frameAnalyzers && h.frameAnalyzers.freezes) || null;
    } catch (_) { return null; }
}
function getSilenceAnalyzer() {
    try {
        if (typeof devices === 'undefined') return null;
        const h = devices.STB0 && devices.STB0.videoGrabbers && devices.STB0.videoGrabbers.HDMI;
        return (h && h.audioAnalyzers && h.audioAnalyzers.Silence) || null;
    } catch (_) { return null; }
}
function detach(em, ev, fn) {
    if (!em || !fn) return;
    try {
        if (typeof em.removeListener === 'function') em.removeListener(ev, fn);
        else if (typeof em.off === 'function') em.off(ev, fn);
    } catch (_) { /* ignore */ }
}
const toDate = (v) => (v ? new Date(v) : new Date());

// ---------------------------------------------------------------
// Evidência visual
// ---------------------------------------------------------------
let evidenceCount = 0;

function payloadToWritable(payload) {
    if (payload instanceof Uint8Array) return { data: Buffer.from(payload), options: undefined };
    if (Buffer.isBuffer && Buffer.isBuffer(payload)) return { data: payload, options: undefined };
    if (typeof payload === 'string') {
        const isDataUrl = payload.indexOf('data:image/png;base64,') === 0;
        const b64 = isDataUrl ? payload.split(',')[1] : payload;
        return { data: b64, options: { encoding: 'base64' } };
    }
    throw new Error('Formato de payload não suportado');
}

async function captureEvidence(label) {
    if (!VOD_CFG.captureEvidence || !fs) return null;
    if (evidenceCount >= VOD_CFG.maxEvidenceShots) return null;
    try {
        if (typeof devices === 'undefined') return null;
        const g = devices.STB0 && devices.STB0.videoGrabbers && devices.STB0.videoGrabbers.HDMI;
        if (!g || typeof g.getSnapshot !== 'function') return null;
        const image = await g.getSnapshot(null, 'png');
        if (!image || !image.payload) return null;

        const safe = String(label).replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `${Date.now()}_vod_${safe}.png`;
        const full = path.resolve(VOD_CFG.evidenceDir, filename);
        const { data, options } = payloadToWritable(image.payload);
        await new Promise((res, rej) => {
            fs.writeFile(full, data, options || undefined, (e) => e ? rej(e) : res());
        });
        evidenceCount++;
        log.info(`[${testFile}] 📸 Evidência salva: ${filename}`);
        return { filename, fullPath: full, label };
    } catch (err) {
        log.warn(`[${testFile}] Falha ao capturar evidência (${label}): ${err.message}`);
        return null;
    }
}

// ---------------------------------------------------------------
// Teclas
// ---------------------------------------------------------------
async function runKeySequence(steps, tag) {
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        log.info(`[${testFile}] ${tag} ${i + 1}/${steps.length} -> '${s.key}' (${s.label || ''})`);
        await rcu.sendKey(s.key);
        if (s.delay) await sleep(s.delay);
    }
}
const keyResultToDate = (r) => (r && r.to) ? new Date(r.to) : new Date();

async function ensureAudioLevel() {
    try {
        for (let i = 0; i < 3; i++) { await rcu.sendKey('volUp', 200); await sleep(200); }
        log.debug(`[${testFile}] Volume elevado (antes do trigger)`);
    } catch (err) {
        log.warn(`[${testFile}] Não foi possível elevar o volume: ${err.message}`);
    }
}

// =================================================================
// FASE 2A — EMERGÊNCIA DE CONTEÚDO
// =================================================================
async function waitForContentEmergence(cfg) {
    const C = cfg;
    const fa = getFreezeAnalyzer();
    const aa = getSilenceAnalyzer();

    const startedAt = new Date();
    const artifacts = [], audioEvents = [], evidence = [], blacknessValues = [];
    let pendingFreeze = null, pendingSilence = null;
    let lastArtifactEndAt = startedAt.getTime();
    let emergedAt = null, abortReason = null, silenceAccumMs = 0;
    let onFS, onFE, onSS, onSE;

    if (fa && typeof fa.on === 'function') {
        onFS = (ev) => {
            pendingFreeze = {
                from: toDate(ev && (ev.from || ev.at || ev.since)),
                blackness: Number(ev && ev.blackness) || 0
            };
        };
        onFE = (ev) => {
            const from = toDate((ev && ev.from) || (pendingFreeze && pendingFreeze.from));
            const to = toDate(ev && ev.to);
            const blackness = Number(
                (ev && ev.blackness !== undefined) ? ev.blackness
                    : (pendingFreeze && pendingFreeze.blackness)) || 0;
            artifacts.push({
                from, to,
                duration: (ev && ev.duration) || (to.getTime() - from.getTime()),
                blackness,
                mnemonic: (ev && ev.mnemonic) || (blackness >= C.minBlackBlackness ? 'B' : 'F')
            });
            blacknessValues.push(blackness);
            lastArtifactEndAt = Math.max(lastArtifactEndAt, to.getTime());
            pendingFreeze = null;
        };
        try { fa.on('freezeStart', onFS); fa.on('freezeEnd', onFE); }
        catch (_) { log.warn(`[${testFile}] Não foi possível assinar eventos de vídeo (intro)`); }
    } else {
        log.warn(`[${testFile}] frameAnalyzers.freezes indisponível — emergência não monitorada`);
    }

    if (aa && typeof aa.on === 'function') {
        onSS = (ev) => { pendingSilence = { from: toDate(ev && (ev.from || ev.at || ev.since)) }; };
        onSE = (ev) => {
            const from = toDate((ev && ev.from) || (pendingSilence && pendingSilence.from));
            const to = toDate(ev && ev.to);
            const dur = (ev && ev.duration) || (to.getTime() - from.getTime());
            audioEvents.push({ from, to, duration: dur });
            silenceAccumMs += dur;
            pendingSilence = null;
        };
        try { aa.on('silenceStart', onSS); aa.on('silenceEnd', onSE); }
        catch (_) { /* ignore */ }
    }

    log.info(`[${testFile}] FASE 2A — aguardando conteúdo emergir ` +
        `(tolerância de intro: até ${C.maxIntroWaitMs}ms; ` +
        `critério: ${C.minEmergenceCleanMs}ms contínuos sem artefato)...`);

    const deadline = startedAt.getTime() + C.maxIntroWaitMs;
    let lastShotAt = 0, lastLogAt = 0;

    try {
        while (Date.now() < deadline) {
            await sleep(250);
            const now = Date.now();
            const elapsed = now - startedAt.getTime();

            if (!pendingFreeze && (now - lastArtifactEndAt) >= C.minEmergenceCleanMs) {
                emergedAt = new Date();
                break;
            }
            if (elapsed - lastLogAt >= 10000) {
                lastLogAt = elapsed;
                const blackMs = artifacts.reduce((s, a) => s + a.duration, 0);
                log.info(`[${testFile}] FASE 2A +${Math.round(elapsed / 1000)}s: ` +
                    `${artifacts.length} artefato(s), ${blackMs}ms de preto/freeze, ` +
                    `aguardando conteúdo...`);
            }
            if (C.captureEvidence && (now - lastShotAt) >= C.introEvidenceEveryMs) {
                lastShotAt = now;
                const shot = await captureEvidence(`intro_t${Math.round(elapsed / 1000)}s`);
                if (shot) { shot.note = `Durante intro/abertura +${elapsed}ms`; evidence.push(shot); }
            }
            const silentNowMs = pendingSilence ? (now - pendingSilence.from.getTime()) : 0;
            if (elapsed >= C.introNoAudioAbortMs && silentNowMs >= C.introNoAudioAbortMs) {
                abortReason = `Silêncio contínuo de ${silentNowMs}ms durante tela preta — ` +
                    `não é intro, é falha de playback.`;
                log.error(`[${testFile}] FASE 2A abortada: ${abortReason}`);
                break;
            }
        }
    } finally {
        detach(fa, 'freezeStart', onFS); detach(fa, 'freezeEnd', onFE);
        detach(aa, 'silenceStart', onSS); detach(aa, 'silenceEnd', onSE);
    }

    const endedAt = new Date();
    const waitedMs = endedAt.getTime() - startedAt.getTime();

    if (pendingFreeze) {
        artifacts.push({
            from: pendingFreeze.from, to: endedAt,
            duration: endedAt.getTime() - pendingFreeze.from.getTime(),
            blackness: pendingFreeze.blackness,
            mnemonic: (pendingFreeze.blackness >= C.minBlackBlackness ? 'B+' : 'F+'),
            inProgress: true
        });
        blacknessValues.push(pendingFreeze.blackness);
    }
    const stillSilent = !!pendingSilence;
    if (stillSilent) silenceAccumMs += (endedAt.getTime() - pendingSilence.from.getTime());

    if (!emergedAt && !abortReason) {
        const shot = await captureEvidence('intro_timeout');
        if (shot) { shot.note = `Conteúdo NÃO emergiu em ${waitedMs}ms`; evidence.push(shot); }
        log.warn(`[${testFile}] FASE 2A — conteúdo NÃO emergiu em ${waitedMs}ms`);
    } else if (emergedAt) {
        log.info(`[${testFile}] FASE 2A — conteúdo EMERGIU após ${waitedMs}ms ` +
            `(${artifacts.length} artefato(s) de intro)`);
    }

    return {
        startedAt, endedAt, waitedMs, emerged: !!emergedAt, emergedAt, abortReason,
        artifacts, audioEvents, evidence, blacknessValues, silenceAccumMs, stillSilent
    };
}

function analyzeIntro(intro, cfg) {
    const C = cfg || VOD_CFG;
    const out = {
        enabled: true, emerged: !!(intro && intro.emerged),
        waitedMs: intro ? intro.waitedMs : 0,
        artifactCount: 0, blackMs: 0, freezeMs: 0, trueBlackMs: 0, blackRatio: 0,
        blacknessMin: null, blacknessMax: null, blacknessRange: 0, contentVaried: false,
        audioActive: false, silenceRatio: 0,
        abortReason: (intro && intro.abortReason) || null
    };
    if (!intro) return out;

    const W = Math.max(1, intro.waitedMs);
    for (const a of (intro.artifacts || [])) {
        out.artifactCount++;
        if (String(a.mnemonic || '').startsWith('B')) {
            out.blackMs += a.duration;
            if (a.blackness >= C.trueBlackThreshold) out.trueBlackMs += a.duration;
        } else out.freezeMs += a.duration;
    }
    out.blackRatio = out.blackMs / W;

    const bv = intro.blacknessValues || [];
    if (bv.length) {
        out.blacknessMin = Math.min.apply(null, bv);
        out.blacknessMax = Math.max.apply(null, bv);
        out.blacknessRange = out.blacknessMax - out.blacknessMin;
        out.contentVaried = out.blacknessRange >= C.introBlacknessVarianceMin;
    }
    out.silenceRatio = (intro.silenceAccumMs || 0) / W;
    out.audioActive = !intro.stillSilent && out.silenceRatio < 0.6;
    return out;
}

// =================================================================
// FASE 2B + FASE 3 (GRACE) — playback contínuo com confirmação de borda
// =================================================================
async function monitorSteadyPlayback(durationMs) {
    const C = VOD_CFG;
    const fa = getFreezeAnalyzer();
    const aa = getSilenceAnalyzer();
    const collected = { video: [], audio: [] };
    const evidence = [];
    const startedAt = new Date();

    let pendingFreeze = null, pendingSilence = null;
    let onFS, onFE, onSS, onSE;

    const artifactWatchTimer = setInterval(async () => {
        if (!pendingFreeze) return;
        const elapsed = Date.now() - pendingFreeze.from.getTime();
        if (elapsed >= C.evidenceOnArtifactMs && !pendingFreeze.shot) {
            pendingFreeze.shot = true;
            const bl = pendingFreeze.blackness;
            const kind = (bl >= C.trueBlackThreshold) ? 'trueblack'
                : (bl >= C.minBlackBlackness) ? 'darkscene' : 'freeze';
            const shot = await captureEvidence(`steady_${kind}_${Math.round(elapsed)}ms`);
            if (shot) {
                shot.note = `Artefato em curso há ${elapsed}ms (blackness ${bl}%)`;
                evidence.push(shot);
            }
        }
    }, 1000);

    let filmstripTimer = null;
    if (C.filmstripEverySteadyMs > 0) {
        filmstripTimer = setInterval(async () => {
            const off = Date.now() - startedAt.getTime();
            const shot = await captureEvidence(`steady_t${Math.round(off / 1000)}s`);
            if (shot) { shot.note = `Filmstrip +${off}ms`; evidence.push(shot); }
        }, C.filmstripEverySteadyMs);
    }

    if (fa && typeof fa.on === 'function') {
        onFS = (ev) => {
            pendingFreeze = {
                from: toDate(ev && (ev.from || ev.at || ev.since)),
                blackness: Number(ev && ev.blackness) || 0, shot: false
            };
        };
        onFE = (ev) => {
            const from = toDate((ev && ev.from) || (pendingFreeze && pendingFreeze.from));
            const to = toDate(ev && ev.to);
            const blackness = Number(
                (ev && ev.blackness !== undefined) ? ev.blackness
                    : (pendingFreeze && pendingFreeze.blackness)) || 0;
            collected.video.push({
                from, to,
                duration: (ev && ev.duration) || (to.getTime() - from.getTime()),
                trueDurationMs: to.getTime() - from.getTime(),
                blackness,
                mnemonic: (ev && ev.mnemonic) || (blackness >= C.minBlackBlackness ? 'B' : 'F')
            });
            pendingFreeze = null;
        };
        try { fa.on('freezeStart', onFS); fa.on('freezeEnd', onFE); }
        catch (_) { log.warn(`[${testFile}] Não foi possível assinar eventos de vídeo`); }
    }

    if (aa && typeof aa.on === 'function') {
        onSS = (ev) => { pendingSilence = { from: toDate(ev && (ev.from || ev.at || ev.since)) }; };
        onSE = (ev) => {
            const from = toDate((ev && ev.from) || (pendingSilence && pendingSilence.from));
            const to = toDate(ev && ev.to);
            collected.audio.push({
                from, to,
                duration: (ev && ev.duration) || (to.getTime() - from.getTime()),
                trueDurationMs: to.getTime() - from.getTime()
            });
            pendingSilence = null;
        };
        try { aa.on('silenceStart', onSS); aa.on('silenceEnd', onSE); }
        catch (_) { /* ignore */ }
    }

    log.info(`[${testFile}] FASE 2B — avaliando playback por ${durationMs}ms ` +
        `(ruído < ${C.minArtifactDurationMs}ms será descartado)...`);

    let graceInfo = { ran: false, resolved: null, graceMs: 0, artifactTotalMs: 0, kind: null };

    try {
        await sleep(durationMs);

        // ============ FASE 3: GRACE / CONFIRMAÇÃO DE BORDA ============
        // O fim da janela é arbitrário. Se há artefato em curso, NÃO conclui:
        // observa mais um pouco para saber se era cena ou falha real.
        if (pendingFreeze && C.endArtifactGraceMs > 0) {
            const bl = pendingFreeze.blackness;
            graceInfo.kind = (bl >= C.trueBlackThreshold) ? 'TRUE_BLACK'
                : (bl >= C.minBlackBlackness) ? 'DARK_SCENE' : 'FREEZE';
            const already = Date.now() - pendingFreeze.from.getTime();

            log.warn(`[${testFile}] ---------- FASE 3: GRACE (confirmação de borda) ----------`);
            log.warn(`[${testFile}] Janela fechou com ${graceInfo.kind} em curso há ${already}ms ` +
                `(blackness ${bl}%). Observando até ${C.endArtifactGraceMs}ms para confirmar ` +
                `se é cena ou falha real...`);

            const videoCountBefore = collected.video.length;
            const graceStart = Date.now();
            let lastGraceShot = 0;

            while (pendingFreeze && (Date.now() - graceStart) < C.endArtifactGraceMs) {
                await sleep(250);
                const g = Date.now() - graceStart;
                if (C.captureEvidence && (g - lastGraceShot) >= C.graceEvidenceEveryMs) {
                    lastGraceShot = g;
                    const shot = await captureEvidence(`grace_${graceInfo.kind.toLowerCase()}_${Math.round(g / 1000)}s`);
                    if (shot) {
                        shot.note = `GRACE +${g}ms — artefato ainda em curso`;
                        evidence.push(shot);
                    }
                }
            }

            graceInfo.ran = true;
            graceInfo.graceMs = Date.now() - graceStart;

            if (!pendingFreeze) {
                graceInfo.resolved = true;
                // O evento resolvido foi empurrado por onFE: marca-o.
                if (collected.video.length > videoCountBefore) {
                    const ev = collected.video[collected.video.length - 1];
                    ev.resolvedInGrace = true;
                    graceInfo.artifactTotalMs = ev.trueDurationMs || 0;
                }
                log.info(`[${testFile}] ✅ GRACE: artefato RESOLVEU após +${graceInfo.graceMs}ms ` +
                    `(duração real ${graceInfo.artifactTotalMs}ms). ` +
                    `Era cena/plano estático — NÃO é falha de playback.`);
                const shot = await captureEvidence('grace_resolved');
                if (shot) { shot.note = 'Após o artefato resolver — conteúdo voltou'; evidence.push(shot); }
            } else {
                graceInfo.resolved = false;
                graceInfo.artifactTotalMs = Date.now() - pendingFreeze.from.getTime();
                log.error(`[${testFile}] ❌ GRACE: artefato PERSISTIU por +${graceInfo.graceMs}ms ` +
                    `(total ${graceInfo.artifactTotalMs}ms). Falha de playback CONFIRMADA.`);
            }
        }
    } finally {
        clearInterval(artifactWatchTimer);
        if (filmstripTimer) clearInterval(filmstripTimer);
        detach(fa, 'freezeStart', onFS); detach(fa, 'freezeEnd', onFE);
        detach(aa, 'silenceStart', onSS); detach(aa, 'silenceEnd', onSE);
    }

    // Janela de MEDIÇÃO permanece a original (grace não infla as métricas)
    const endedAt = new Date(startedAt.getTime() + durationMs);
    const closedAt = new Date();

    if (pendingFreeze) {
        collected.video.push({
            from: pendingFreeze.from, to: closedAt,
            duration: closedAt.getTime() - pendingFreeze.from.getTime(),
            trueDurationMs: graceInfo.artifactTotalMs ||
                (closedAt.getTime() - pendingFreeze.from.getTime()),
            blackness: pendingFreeze.blackness,
            mnemonic: (pendingFreeze.blackness >= C.minBlackBlackness ? 'B+' : 'F+'),
            inProgress: true, resolvedInGrace: false
        });
        const shot = await captureEvidence('steady_end_artifact');
        if (shot) { shot.note = 'Artefato persistente no fim da janela'; evidence.push(shot); }
    }
    if (pendingSilence) {
        collected.audio.push({
            from: pendingSilence.from, to: closedAt,
            duration: closedAt.getTime() - pendingSilence.from.getTime(),
            inProgress: true
        });
        log.warn(`[${testFile}] FASE 2B encerrou com SILÊNCIO em curso`);
    }

    log.info(`[${testFile}] FASE 2B concluída: ${collected.video.length} evento(s) BRUTOS, ` +
        `${collected.audio.length} de áudio, ${evidence.length} evidência(s)`);

    return {
        startedAt, endedAt, windowMs: durationMs,
        collected, evidence, graceInfo
    };
}

function classifyKind(mn, blackness, C) {
    if (!String(mn || '').startsWith('B')) return 'FREEZE';
    return (blackness >= C.trueBlackThreshold) ? 'TRUE_BLACK' : 'DARK_SCENE';
}

function analyzeSteady(steady, cfg) {
    const C = cfg || VOD_CFG;
    const tStart = steady.startedAt.getTime();
    const tEnd = steady.endedAt.getTime();
    const W = Math.max(1, tEnd - tStart);

    const out = {
        windowMs: tEnd - tStart,
        trueBlackMs: 0, darkSceneMs: 0, freezeMs: 0, silenceMs: 0,
        trueBlackRatio: 0, darkRatio: 0, freezeRatio: 0, silenceRatio: 0,
        endedInTrueBlack: false, endedInFreeze: false, endedInSilence: false,
        longestCleanGapMs: 0, longestNonCriticalGapMs: 0, criticalEventCount: 0,
        rawEventCount: 0, filteredEventCount: 0, discardedNoiseCount: 0, discardedNoiseMs: 0,
        rawCoverageRatio: 0, analyzerSaturated: false,
        maxTrueBlackEpisodeMs: 0, maxFreezeEpisodeMs: 0,
        boundaryResolved: false, boundaryArtifactMs: 0, boundaryKind: null,
        audioEventCount: 0, events: [], rawEvents: []
    };

    const g = steady.graceInfo || {};
    if (g.ran) {
        out.boundaryResolved = g.resolved === true;
        out.boundaryArtifactMs = g.artifactTotalMs || 0;
        out.boundaryKind = g.kind || null;
    }

    const raw = (steady.collected.video || []).slice()
        .sort((a, b) => a.from.getTime() - b.from.getTime());
    out.rawEventCount = raw.length;
    out.audioEventCount = (steady.collected.audio || []).length;

    let cursor = tStart, covered = 0;
    for (const e of raw) {
        const f = Math.max(e.from.getTime(), tStart);
        const t = Math.min(e.to.getTime(), tEnd);
        if (t > cursor) { covered += t - Math.max(f, cursor); cursor = t; }
    }
    out.rawCoverageRatio = covered / W;

    for (const e of raw) {
        out.rawEvents.push({
            kind: classifyKind(e.mnemonic, e.blackness, C),
            mnemonic: e.mnemonic || '',
            offset_ms: e.from.getTime() - tStart,
            duration_ms: Math.max(0, Math.min(e.to.getTime(), tEnd) - Math.max(e.from.getTime(), tStart)),
            blackness: Number(e.blackness || 0).toFixed(2)
        });
    }

    // merge conservador
    const merged = [];
    for (const e of raw) {
        const kind = classifyKind(e.mnemonic, e.blackness, C);
        const f = Math.max(e.from.getTime(), tStart);
        const t = Math.min(e.to.getTime(), tEnd);
        if (t <= f) continue;
        const last = merged[merged.length - 1];
        if (last && last.kind === kind && (f - last.to) <= C.mergeGapMs) {
            last.to = Math.max(last.to, t);
            last.blackness = Math.max(last.blackness, Number(e.blackness) || 0);
            last.inProgress = last.inProgress || !!e.inProgress;
            last.resolvedInGrace = last.resolvedInGrace || !!e.resolvedInGrace;
            last.trueDurationMs = Math.max(last.trueDurationMs || 0,
                e.trueDurationMs || 0, last.to - last.from);
        } else {
            merged.push({
                kind, from: f, to: t, blackness: Number(e.blackness) || 0,
                mnemonic: e.mnemonic || '', inProgress: !!e.inProgress,
                resolvedInGrace: !!e.resolvedInGrace,
                trueDurationMs: e.trueDurationMs || (t - f)
            });
        }
    }

    // filtro de ruído
    const kept = [];
    for (const m of merged) {
        const dur = m.to - m.from;
        if (dur < C.minArtifactDurationMs) {
            out.discardedNoiseCount++; out.discardedNoiseMs += dur;
        } else kept.push(m);
    }
    out.filteredEventCount = kept.length;

    let cur = tStart;
    for (const m of kept) {
        const dur = m.to - m.from;
        const gap = m.from - cur;
        if (gap > out.longestCleanGapMs) out.longestCleanGapMs = gap;
        cur = Math.max(cur, m.to);

        // Episódio: usa a duração REAL (medida no grace), não a truncada pelo corte
        const episodeMs = Math.max(dur, m.trueDurationMs || 0);
        if (m.kind === 'FREEZE') {
            out.freezeMs += dur;
            if (episodeMs > out.maxFreezeEpisodeMs) out.maxFreezeEpisodeMs = episodeMs;
        } else if (m.kind === 'TRUE_BLACK') {
            out.trueBlackMs += dur;
            if (episodeMs > out.maxTrueBlackEpisodeMs) out.maxTrueBlackEpisodeMs = episodeMs;
        } else out.darkSceneMs += dur;

        out.events.push({
            kind: m.kind, mnemonic: m.mnemonic,
            offset_ms: m.from - tStart, duration_ms: dur,
            true_duration_ms: episodeMs,
            resolved_in_grace: m.resolvedInGrace ? 'SIM' : '',
            blackness: Number(m.blackness).toFixed(2)
        });
    }
    const tail = tEnd - cur;
    if (tail > out.longestCleanGapMs) out.longestCleanGapMs = tail;
    if (kept.length === 0) out.longestCleanGapMs = out.windowMs;

    // ---- "terminou em falha" só quando o GRACE confirma persistência ----
    if (kept.length) {
        const last = kept[kept.length - 1];
        const touchesEnd = last.inProgress || last.to >= tEnd - 250;
        if (touchesEnd) {
            const episodeMs = Math.max(last.to - last.from, last.trueDurationMs || 0);
            // Resolveu no grace -> era cena, não conta como término em falha.
            // Sem grace disponível -> exige duração conclusiva.
            const conclusive = out.boundaryResolved === false && g.ran
                ? true
                : (!g.ran && episodeMs >= C.minConclusiveEndArtifactMs);
            if (conclusive && !last.resolvedInGrace) {
                if (last.kind === 'FREEZE') out.endedInFreeze = true;
                else if (last.kind === 'TRUE_BLACK') out.endedInTrueBlack = true;
            }
        }
    }

    // artefatos críticos (para fragmentação)
    const critical = kept.filter(m => m.kind === 'TRUE_BLACK' || m.kind === 'FREEZE');
    out.criticalEventCount = critical.length;
    if (critical.length === 0) {
        out.longestNonCriticalGapMs = out.windowMs;
    } else {
        let c = tStart;
        for (const m of critical) {
            const gp = m.from - c;
            if (gp > out.longestNonCriticalGapMs) out.longestNonCriticalGapMs = gp;
            c = Math.max(c, m.to);
        }
        const tl = tEnd - c;
        if (tl > out.longestNonCriticalGapMs) out.longestNonCriticalGapMs = tl;
    }

    for (const ev of (steady.collected.audio || [])) {
        const f = Math.max(ev.from.getTime(), tStart);
        const t = Math.min(ev.to.getTime(), tEnd);
        out.silenceMs += Math.max(0, t - f);
        if (ev.inProgress || t >= tEnd - 250) out.endedInSilence = true;
    }

    out.trueBlackRatio = out.trueBlackMs / W;
    out.darkRatio = out.darkSceneMs / W;
    out.freezeRatio = out.freezeMs / W;
    out.silenceRatio = out.silenceMs / W;
    out.analyzerSaturated = out.rawCoverageRatio >= C.saturationCoverageRatio;
    return out;
}

// ---------------------------------------------------------------
// FASE 1
// ---------------------------------------------------------------
function analyzeOpen(w, triggerDate, cfg) {
    const C = cfg || VOD_CFG;
    const out = {
        ok: false, status: 'OPEN_FAILED', reason: '',
        timeToPlayMs: null, startupBlackMs: 0, videoAtMs: null, soundAtMs: null,
        warnings: [], slow: false, silentOpening: false
    };
    if (!w || !triggerDate) { out.reason = 'Watcher não retornou dados de abertura.'; return out; }

    const t0 = new Date(triggerDate).getTime();
    const rel = (d) => (d ? (new Date(d).getTime() - t0) : null);
    out.videoAtMs = rel(w.videoAt);
    out.soundAtMs = rel(w.soundAt);
    out.startupBlackMs = w.blackDuration || 0;

    let lastEnd = 0;
    if (Array.isArray(w.freezes)) {
        lastEnd = w.freezes.reduce((mx, f) => {
            const e = f.to ? new Date(f.to).getTime() : 0; return e > mx ? e : mx;
        }, 0);
    }
    const cands = [w.soundAt ? new Date(w.soundAt).getTime() : null, lastEnd || null].filter(v => v);
    const startMs = cands.length ? Math.max.apply(null, cands) : null;
    if (startMs) out.timeToPlayMs = startMs - t0;
    else if (w.duration) out.timeToPlayMs = w.duration;

    if (w.resultCode === 0) {
        out.ok = true; out.status = 'OPEN_OK';
        out.reason = `Mídia aberta e estabilizada em ${out.timeToPlayMs}ms ` +
            `(vídeo +${out.videoAtMs}ms, áudio +${out.soundAtMs}ms).`;
    } else if (w.videoAt && w.soundAt) {
        out.ok = true; out.status = 'OPEN_UNCONFIRMED';
        out.reason = `Vídeo e áudio detectados (${out.timeToPlayMs}ms), sem estabilização formal.`;
        out.warnings.push('Abertura aprovada por evidência de vídeo+áudio, não por resultCode.');
    } else {
        out.reason = `Mídia não abriu: ${w.videoAt ? '' : 'sem vídeo estabilizado; '}` +
            `${w.soundAt ? '' : 'sem áudio detectado; '}preto de ${out.startupBlackMs}ms.`;
    }

    const videoWasFast = (out.videoAtMs !== null && out.videoAtMs <= C.silentOpeningVideoMs);
    const audioArrived = (out.soundAtMs !== null && out.soundAtMs <= C.maxTimeToAudioMs);
    if (out.ok && out.timeToPlayMs > C.maxTimeToPlayMs) {
        if (videoWasFast && audioArrived) {
            out.silentOpening = true;
            out.warnings.push(
                `Abertura SILENCIOSA do conteúdo: vídeo em +${out.videoAtMs}ms, ` +
                `áudio só em +${out.soundAtMs}ms. Característica do título, não lentidão do sistema.`);
        } else {
            out.slow = true;
            out.warnings.push(`Abertura LENTA: ${out.timeToPlayMs}ms (limite ${C.maxTimeToPlayMs}ms).`);
        }
    }

    const hadAudio = !!(w && w.soundAt);
    const blackLimit = hadAudio ? C.maxStartupBlackMs : C.maxStartupBlackNoAudioMs;
    if (out.startupBlackMs > blackLimit) {
        out.ok = false; out.status = 'OPEN_BLACK_TOO_LONG';
        out.reason = `Preto de carregamento excessivo: ${out.startupBlackMs}ms ` +
            `(limite ${blackLimit}ms ${hadAudio ? 'com' : 'SEM'} áudio detectado).`;
    } else if (hadAudio && out.startupBlackMs > C.maxStartupBlackNoAudioMs) {
        out.warnings.push(
            `Preto de abertura longo (${out.startupBlackMs}ms) porém COM áudio — ` +
            `compatível com abertura escura de filme.`);
    }
    return out;
}

// ---------------------------------------------------------------
// Áudio
// ---------------------------------------------------------------
async function readSilenceState() {
    const a = getSilenceAnalyzer();
    if (!a) return { known: false, silent: null, via: 'analyzer-unavailable' };
    for (const p of ['isSilent', 'silent', 'isActive', 'active']) {
        if (typeof a[p] === 'boolean') return { known: true, silent: a[p], via: `prop:${p}` };
    }
    for (const m of ['getStatus', 'getState', 'status', 'state']) {
        try {
            const v = (typeof a[m] === 'function') ? await a[m]() : a[m];
            if (v && typeof v === 'object') {
                if (typeof v.silent === 'boolean') return { known: true, silent: v.silent, via: `${m}.silent` };
                if (typeof v.active === 'boolean') return { known: true, silent: v.active, via: `${m}.active` };
            }
            if (typeof v === 'boolean') return { known: true, silent: v, via: m };
        } catch (_) { /* segue */ }
    }
    return { known: false, silent: null, via: 'no-state-api' };
}

async function probeAudioByMute(timeoutMs) {
    const a = getSilenceAnalyzer();
    if (!a || typeof a.on !== 'function') return { conclusive: false, hadAudio: null, method: 'no-events' };
    let onStart = null, timer = null;
    try {
        const detected = await new Promise(async (resolve) => {
            let settled = false;
            const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
            onStart = () => { log.info(`[${testFile}] 'silenceStart' após mute -> havia áudio`); finish(true); };
            try { a.on('silenceStart', onStart); } catch (_) { return finish(null); }
            timer = setTimeout(() => finish(false), timeoutMs);
            try { await rcu.sendKey('mute'); }
            catch (err) { log.warn(`[${testFile}] Falha no mute: ${err.message}`); finish(null); }
        });
        if (detected === null) return { conclusive: false, hadAudio: null, method: 'probe-error' };
        return { conclusive: true, hadAudio: detected === true, method: 'mute-probe' };
    } finally {
        if (timer) clearTimeout(timer);
        detach(a, 'silenceStart', onStart);
        try { await rcu.sendKey('mute'); log.debug(`[${testFile}] Mute desfeito`); }
        catch (err) { log.warn(`[${testFile}] Falha ao desfazer mute: ${err.message}`); }
    }
}

// ---------------------------------------------------------------
// Veredito
// ---------------------------------------------------------------
function buildVerdict(ctx) {
    const { openPhase, introStats, steadyStats: s, audioProbe, audioState, openAudioOk, cfg } = ctx;
    const C = cfg || VOD_CFG;
    const v = {
        success: false, diagnosis: 'UNKNOWN', open: openPhase, intro: introStats,
        video: { ok: false, reason: '' },
        audio: { ok: false, reason: '', confidence: 'unknown' },
        warnings: (openPhase.warnings || []).slice(),
        needsVisualReview: false
    };

    if (!openPhase.ok) {
        v.diagnosis = openPhase.status;
        v.video.reason = openPhase.reason;
        v.audio.reason = 'Não avaliado — a mídia não abriu.';
        v.timeToPlayMs = openPhase.timeToPlayMs;
        v.resultCode = -1;
        return v;
    }

    if (introStats && introStats.abortReason) {
        v.diagnosis = 'NO_VIDEO_NO_AUDIO';
        v.video.reason = `Tela preta sem áudio durante ${introStats.waitedMs}ms. ` + introStats.abortReason;
        v.audio.ok = false; v.audio.confidence = 'confirmed';
        v.audio.reason = 'Silêncio contínuo — playback não iniciou de fato.';
        v.timeToPlayMs = openPhase.timeToPlayMs; v.resultCode = -1;
        return v;
    }

    if (introStats && introStats.enabled && !introStats.emerged) {
        const blkPct = (introStats.blackRatio * 100).toFixed(1);
        if (introStats.audioActive) {
            v.needsVisualReview = true;
            v.diagnosis = 'INTRO_NO_CONTENT_REVIEW';
            v.video.reason =
                `Conteúdo não emergiu em ${introStats.waitedMs}ms (preto/artefato ${blkPct}%), ` +
                `mas o ÁUDIO estava fluindo` +
                (introStats.contentVaried
                    ? ` e a blackness OSCILOU ${introStats.blacknessRange.toFixed(1)} p.p., ` +
                    `sugerindo intro/abertura longa`
                    : ` porém a blackness ficou PRATICAMENTE CONSTANTE ` +
                    `(${introStats.blacknessRange.toFixed(1)} p.p.), compatível com vídeo morto`) +
                `. Confira os snapshots.`;
            v.audio.ok = true; v.audio.confidence = 'confirmed';
            v.audio.reason = `Áudio ativo durante a espera (silêncio ${(introStats.silenceRatio * 100).toFixed(1)}%).`;
            v.warnings.push(`Intro excedeu a tolerância de ${C.maxIntroWaitMs}ms.`);
        } else {
            v.diagnosis = 'PLAYBACK_BLACK';
            v.video.reason = `Conteúdo não emergiu em ${introStats.waitedMs}ms (preto ${blkPct}%) e sem áudio.`;
            v.audio.ok = false; v.audio.confidence = 'confirmed';
            v.audio.reason = `Silêncio em ${(introStats.silenceRatio * 100).toFixed(1)}% da espera.`;
        }
        v.timeToPlayMs = openPhase.timeToPlayMs; v.resultCode = -1;
        return v;
    }

    const tbPct = (s.trueBlackRatio * 100).toFixed(1);
    const dkPct = (s.darkRatio * 100).toFixed(1);
    const fzPct = (s.freezeRatio * 100).toFixed(1);
    const slPct = (s.silenceRatio * 100).toFixed(1);

    if (s.discardedNoiseCount > 0) {
        v.warnings.push(
            `${s.discardedNoiseCount} micro-evento(s) somando ${s.discardedNoiseMs}ms descartados ` +
            `como ruído de captura (< ${C.minArtifactDurationMs}ms) — típico de conteúdo 24fps.`);
    }
    if (s.boundaryResolved) {
        v.warnings.push(
            `A janela fechou durante um ${s.boundaryKind} de ${s.boundaryArtifactMs}ms, mas ele ` +
            `RESOLVEU na fase de confirmação — era cena/plano estático, não falha. ` +
            `Sem a confirmação, este teste teria reprovado por coincidência de corte.`);
    }

    // ---------- ÁUDIO ----------
    if (s.endedInSilence) {
        v.audio.ok = false; v.audio.confidence = 'confirmed';
        v.audio.reason = `Playback terminou em SILÊNCIO (silêncio ${slPct}% da janela).`;
    } else if (s.silenceRatio > C.maxSteadySilenceRatio) {
        v.audio.ok = false; v.audio.confidence = 'confirmed';
        v.audio.reason = `Silêncio em ${slPct}% do playback (limite ${(C.maxSteadySilenceRatio * 100).toFixed(0)}%).`;
    } else if (s.audioEventCount > 0) {
        v.audio.ok = true; v.audio.confidence = 'confirmed';
        v.audio.reason = `Áudio presente; silêncio de apenas ${slPct}% ` +
            `(${s.audioEventCount} interrupção(ões) curta(s)).`;
    } else if (audioState && audioState.known) {
        v.audio.ok = (audioState.silent === false); v.audio.confidence = 'confirmed';
        v.audio.reason = v.audio.ok ? `Estado do analisador: COM ÁUDIO (${audioState.via}).`
            : `Estado do analisador: SILENCIOSO (${audioState.via}).`;
    } else if (audioProbe && audioProbe.conclusive) {
        v.audio.ok = audioProbe.hadAudio === true; v.audio.confidence = 'confirmed';
        v.audio.reason = v.audio.ok ? `Sonda de mute confirmou áudio contínuo.`
            : `Sonda de mute não gerou 'silenceStart' — sem áudio.`;
    } else if (openAudioOk) {
        v.audio.ok = true; v.audio.confidence = 'confirmed';
        v.audio.reason = `Áudio confirmado na abertura (+${openPhase.soundAtMs}ms) e ` +
            `nenhum silêncio durante ${s.windowMs}ms de playback.`;
    } else if (C.treatNoSilenceEventsAsAudio) {
        v.audio.ok = true; v.audio.confidence = 'inferred';
        v.audio.reason = `Nenhum evento de silêncio em ${s.windowMs}ms — áudio contínuo inferido.`;
        v.warnings.push('Áudio inferido por ausência de eventos.');
    } else {
        v.audio.reason = 'Não foi possível determinar o estado do áudio.';
    }
    const audioFlowing = v.audio.ok;

    // ---------- VÍDEO ----------
    const contentProven = !!(introStats && introStats.enabled && introStats.emerged);
    const blackDominant = s.trueBlackRatio > C.maxSteadyTrueBlackRatio;
    const blackAtEnd = s.endedInTrueBlack;          // já confirmado pelo grace
    const freezeDominant = s.freezeRatio > C.maxSteadyFreezeRatio;
    const freezeAtEnd = s.endedInFreeze;            // já confirmado pelo grace
    const blackEpisodeTooLong = s.maxTrueBlackEpisodeMs >= C.postEmergenceBlackFailMs;
    const freezeEpisodeTooLong = s.maxFreezeEpisodeMs >= C.postEmergenceFreezeFailMs;
    const blackAccumTooHigh = s.trueBlackRatio >= C.postEmergenceBlackHardRatio;

    // v9: assinatura de "montagem de abertura escura" — preto alto porém
    // INTERMITENTE, todos os episódios se recuperam, com áudio e trecho limpo.
    // Distingue-se de vídeo morto (que seria 1 bloco contínuo, terminaria em
    // preto, ou não teria áudio).
    const blackIsIntermittentRecovering =
        !s.endedInTrueBlack
        && s.maxTrueBlackEpisodeMs < C.postEmergenceBlackFailMs
        && s.criticalEventCount >= C.darkMontageMinEpisodes
        && s.longestNonCriticalGapMs >= C.minSteadyCleanGapMs
        && audioFlowing && s.silenceRatio < C.maxSteadySilenceRatio
        && s.trueBlackRatio < C.darkMontageMaxBlackRatio;
    // Exceção ao hard-fail por ACÚMULO: quando o único gatilho é a razão alta de
    // preto e o padrão é intermitente-recuperável, não reprova direto — revisa.
    const accumOnlyMontage = C.darkMontageReviewEnabled && blackAccumTooHigh
        && !blackAtEnd && !blackEpisodeTooLong && blackIsIntermittentRecovering;

    if (blackDominant || blackAtEnd) {
        const hardFail = contentProven && (blackAtEnd || blackEpisodeTooLong
            || (blackAccumTooHigh && !accumOnlyMontage));
        if (hardFail) {
            v.diagnosis = 'PLAYBACK_BLACK';
            v.video.reason = blackAtEnd
                ? `Vídeo MORREU: tela preta real persistiu na confirmação ` +
                `(episódio ${s.maxTrueBlackEpisodeMs}ms, preto ${tbPct}%). Não é fade nem intro.`
                : (blackEpisodeTooLong
                    ? `Episódio de tela preta real de ${s.maxTrueBlackEpisodeMs}ms ` +
                    `(limite ${C.postEmergenceBlackFailMs}ms) após o conteúdo ter emergido.`
                    : `Tela preta real ACUMULADA em ${tbPct}% da janela ` +
                    `(limite ${(C.postEmergenceBlackHardRatio * 100).toFixed(0)}%).`);
        } else if (audioFlowing && C.darkOpeningToleranceEnabled
            && !s.endedInTrueBlack
            && s.maxTrueBlackEpisodeMs < C.reviewBlackEpisodeMs
            && s.longestNonCriticalGapMs >= C.minSteadyCleanGapMs
            && s.silenceRatio < C.darkOpeningMaxSilenceRatio) {
            // ---- PROPOSTA A (v8): preto recuperável + áudio contínuo ----
            // Todos os episódios de preto foram curtos, SE RECUPERARAM (não
            // terminou em preto), há um trecho limpo saudável e o áudio é
            // sólido -> abertura escura / fade legítimo, não falha.
            v.video.ok = true;
            v.diagnosis = 'OK_DARK_OPENING';
            v.video.reason =
                `Tela preta em ${tbPct}% em episódios curtos (máx ${s.maxTrueBlackEpisodeMs}ms) ` +
                `que SE RECUPERARAM, com áudio contínuo (silêncio ${slPct}%) e ` +
                `${s.longestNonCriticalGapMs}ms de trecho limpo — abertura escura/fade legítimo.`;
            v.warnings.push(
                `Cenas escuras da abertura toleradas (v8): preto real ${tbPct}% recuperável ` +
                `+ áudio contínuo. Sem esta tolerância, o teste teria caído em REVISAR.`);
        } else if (audioFlowing && C.darkMontageReviewEnabled && blackAccumTooHigh
            && blackIsIntermittentRecovering) {
            // ---- PROPOSTA B (v9): montagem de abertura escura ----
            // Preto acumulado alto, MAS intermitente e recuperável, com áudio e
            // trecho limpo -> não é vídeo morto. Vai para revisão visual em vez
            // de reprovar como PLAYBACK_BLACK.
            v.video.ok = false; v.needsVisualReview = true;
            v.diagnosis = 'DARK_OPENING_REVIEW';
            v.video.reason =
                `Tela preta ACUMULADA em ${tbPct}%, porém concentrada em ${s.criticalEventCount} ` +
                `episódios curtos (máx ${s.maxTrueBlackEpisodeMs}ms) que SE RECUPERARAM, ` +
                `com áudio contínuo (silêncio ${slPct}%) e ${s.longestNonCriticalGapMs}ms de ` +
                `trecho limpo — compatível com montagem de abertura escura (patrocínios/fades). ` +
                `Confira os snapshots.`;
            v.warnings.push(
                `Abertura escura extensa (v9): preto ${tbPct}% alto mas INTERMITENTE e recuperável ` +
                `com áudio — exige conferência visual em vez de reprovação direta. ` +
                `Sem esta regra, o teste teria caído em ERRO (PLAYBACK_BLACK).`);
        } else if (audioFlowing && C.blackWithAudioPolicy === 'inconclusive') {
            v.video.ok = false; v.needsVisualReview = true;
            v.diagnosis = 'BLACK_WITH_AUDIO_REVIEW';
            v.video.reason =
                `Tela preta em ${tbPct}% da janela COM áudio fluindo, em episódios curtos ` +
                `(maior: ${s.maxTrueBlackEpisodeMs}ms). Pode ser fade legítimo — confira os snapshots.`;
            v.warnings.push('Veredito NÃO conclusivo: exige conferência visual dos PNGs.');
        } else {
            v.diagnosis = 'PLAYBACK_BLACK';
            v.video.reason = `Tela preta real em ${tbPct}% do playback ` +
                `(limite ${(C.maxSteadyTrueBlackRatio * 100).toFixed(0)}%).`;
        }
    } else if (freezeDominant || freezeAtEnd) {
        v.diagnosis = 'PLAYBACK_FROZEN';
        v.video.reason = freezeAtEnd
            ? `Vídeo CONGELOU: imagem estática persistiu na confirmação ` +
            `(episódio ${s.maxFreezeEpisodeMs}ms, freeze ${fzPct}%).`
            : `Congelamento em ${fzPct}% do playback ` +
            `(limite ${(C.maxSteadyFreezeRatio * 100).toFixed(0)}%).`;
    } else if (s.longestNonCriticalGapMs < C.minSteadyCleanGapMs && s.criticalEventCount > 0) {
        v.diagnosis = 'PLAYBACK_UNSTABLE';
        v.video.reason = `Playback fragmentado por artefatos críticos: maior trecho sem ` +
            `preto/freeze = ${s.longestNonCriticalGapMs}ms ` +
            `(mínimo ${C.minSteadyCleanGapMs}ms).`;
    } else {
        v.video.ok = true;
        v.video.reason = s.filteredEventCount === 0
            ? `Playback limpo: ${s.windowMs}ms sem nenhum artefato relevante ` +
            `(${s.discardedNoiseCount} micro-evento(s) descartado(s) como ruído).`
            : (s.criticalEventCount === 0
                ? `Playback estável: ${s.windowMs}ms SEM nenhum preto real ou congelamento ` +
                `(apenas ${s.filteredEventCount} trecho(s) de cena escura, ${dkPct}%).`
                : `Playback estável: ${s.longestNonCriticalGapMs}ms sem artefato crítico, ` +
                `preto real ${tbPct}%, cenas escuras ${dkPct}%, freeze ${fzPct}%.`);
        if (s.darkRatio > 0.25) {
            v.warnings.push(`Muitas cenas escuras (${dkPct}%) — normal em VOD escuro ` +
                `(blackness < ${C.trueBlackThreshold}%), não é falha.`);
        }
    }

    if (s.analyzerSaturated) {
        v.warnings.push(
            `Analisador SATURADO: artefatos cobriram ${(s.rawCoverageRatio * 100).toFixed(1)}% ` +
            `da janela no fluxo bruto — em conteúdo muito escuro o detector perde sensibilidade.`);
    }

    v.video.trueBlackPercent = Number(tbPct);
    v.video.darkScenePercent = Number(dkPct);
    v.video.freezePercent = Number(fzPct);
    v.video.longestCleanGapMs = s.longestCleanGapMs;
    v.video.longestNonCriticalGapMs = s.longestNonCriticalGapMs;
    v.video.criticalEventCount = s.criticalEventCount;
    v.audio.silencePercent = Number(slPct);

    v.success = v.video.ok && v.audio.ok;
    if (v.success) {
        const longIntro = introStats && introStats.waitedMs > (C.minEmergenceCleanMs + 5000);
        v.diagnosis = openPhase.slow ? 'OK_SLOW_OPEN'
            : (openPhase.silentOpening ? 'OK_SILENT_OPENING'
                : (longIntro ? 'OK_AFTER_INTRO' : 'OK'));
        if (longIntro) {
            v.warnings.push(
                `Intro de ~${introStats.waitedMs}ms tolerada antes da avaliação ` +
                `(${introStats.artifactCount} artefato(s) de abertura ignorados).`);
        }
    } else if (v.video.ok && !v.audio.ok) {
        v.diagnosis = (v.audio.confidence === 'unknown') ? 'AUDIO_INCONCLUSIVE' : 'PLAYBACK_SILENT';
    }
    v.resultCode = v.success ? 0 : -1;
    v.timeToPlayMs = openPhase.timeToPlayMs;
    return v;
}

// ---------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------
async function main(iteration = 1) {
    const startedAt = new Date();
    log.info(`[${testFile}#${iteration}] === Validação de VOD único (v7 — OPEN/INTRO/STEADY/GRACE) ===`);
    log.info(`[${testFile}#${iteration}] RCU: ${config.RCU.type} / ${config.RCU.name}`);

    let verdict, triggerDate = null, allEvidence = [];
    const emptySteady = {
        windowMs: 0, trueBlackRatio: 0, darkRatio: 0, freezeRatio: 0, silenceRatio: 0,
        trueBlackMs: 0, darkSceneMs: 0, freezeMs: 0, silenceMs: 0,
        endedInTrueBlack: false, endedInFreeze: false, endedInSilence: false,
        longestCleanGapMs: 0, longestNonCriticalGapMs: 0, criticalEventCount: 0,
        rawEventCount: 0, filteredEventCount: 0, discardedNoiseCount: 0, discardedNoiseMs: 0,
        rawCoverageRatio: 0, analyzerSaturated: false,
        maxTrueBlackEpisodeMs: 0, maxFreezeEpisodeMs: 0,
        boundaryResolved: false, boundaryArtifactMs: 0, boundaryKind: null,
        audioEventCount: 0, events: [], rawEvents: []
    };
    let steadyStats = Object.assign({}, emptySteady);
    let introStats = {
        enabled: false, emerged: true, waitedMs: 0, artifactCount: 0,
        blackMs: 0, blackRatio: 0, blacknessRange: 0, contentVaried: false,
        audioActive: true, silenceRatio: 0, abortReason: null
    };

    try {
        let navSteps = VOD_CFG.navigationSequence || [];
        let triggerStep = VOD_CFG.triggerStep;
        if (!triggerStep) {
            if (navSteps.length < 2) throw new Error('navigationSequence/triggerStep inválidos');
            triggerStep = navSteps[navSteps.length - 1];
            navSteps = navSteps.slice(0, -1);
        }

        await runKeySequence(navSteps, 'Nav');
        if (VOD_CFG.ensureAudio) {
            await ensureAudioLevel();
            await sleep(VOD_CFG.preTriggerSettleMs);
        }

        // ============ FASE 1 ============
        log.info(`[${testFile}#${iteration}] ---------- FASE 1: ABERTURA ----------`);
        const watcher = new mediaOpen.MediaOpenWatcher({
            masks: VOD_CFG.masks,
            max_time_wf_stabilization: VOD_CFG.openTimeoutMs,
            min_time_in_motion: VOD_CFG.minTimeInMotion,
            min_freeze_duration: VOD_CFG.minFreezeDuration,
            min_black_blackness: VOD_CFG.minBlackBlackness
        });
        const watcherPromise = watcher.do();

        log.info(`[${testFile}#${iteration}] Trigger -> '${triggerStep.key}' (${triggerStep.label || 'PLAY'})`);
        triggerDate = keyResultToDate(await rcu.sendKey(triggerStep.key));
        watcher.setTriggerDate(triggerDate);

        const watcherResult = await watcherPromise;
        log.info(`[${testFile}#${iteration}] MediaOpenWatcher: ${JSON.stringify(watcherResult)}`);

        const w = (watcherResult && watcherResult.resultCode !== undefined) ? watcherResult : null;
        const openPhase = analyzeOpen(w, triggerDate, VOD_CFG);
        log.info(`[${testFile}#${iteration}] ABERTURA: ${openPhase.status} — ${openPhase.reason}`);
        log.info(`[${testFile}#${iteration}] Time to play: ${openPhase.timeToPlayMs}ms | ` +
            `preto de carregamento: ${openPhase.startupBlackMs}ms (ESPERADO)`);

        if (!openPhase.ok) {
            const shot = await captureEvidence('open_failed');
            if (shot) allEvidence.push(shot);
            verdict = buildVerdict({
                openPhase, introStats, steadyStats, audioProbe: { conclusive: false },
                audioState: { known: false }, openAudioOk: false, cfg: VOD_CFG
            });
        } else {
            const openAudioOk = !!(w && w.soundAt);

            // ============ FASE 2A ============
            if (VOD_CFG.introToleranceEnabled) {
                log.info(`[${testFile}#${iteration}] ---------- FASE 2A: INTRO / EMERGÊNCIA ----------`);
                const introRaw = await waitForContentEmergence(VOD_CFG);
                allEvidence = allEvidence.concat(introRaw.evidence || []);
                introStats = analyzeIntro(introRaw, VOD_CFG);
                log.info(`[${testFile}#${iteration}] INTRO: emergiu=${introStats.emerged} ` +
                    `espera=${introStats.waitedMs}ms artefatos=${introStats.artifactCount} ` +
                    `preto=${introStats.blackMs}ms (${(introStats.blackRatio * 100).toFixed(1)}%) ` +
                    `blacknessRange=${introStats.blacknessRange.toFixed(1)}p.p. ` +
                    `áudioAtivo=${introStats.audioActive}`);
            } else {
                introStats.enabled = false;
            }

            if (introStats.abortReason || (introStats.enabled && !introStats.emerged)) {
                verdict = buildVerdict({
                    openPhase, introStats, steadyStats, audioProbe: { conclusive: false },
                    audioState: { known: false }, openAudioOk, cfg: VOD_CFG
                });
            } else {
                // ============ FASE 2B + FASE 3 ============
                log.info(`[${testFile}#${iteration}] ---------- FASE 2B: PLAYBACK CONTÍNUO ----------`);
                if (VOD_CFG.steadySettleMs) await sleep(VOD_CFG.steadySettleMs);

                const shot0 = await captureEvidence('steady_start');
                if (shot0) { shot0.note = 'Início da avaliação (pós-intro)'; allEvidence.push(shot0); }

                const steady = await monitorSteadyPlayback(VOD_CFG.steadyWindowMs);
                allEvidence = allEvidence.concat(steady.evidence || []);
                steadyStats = analyzeSteady(steady, VOD_CFG);

                log.info(`[${testFile}#${iteration}] STEADY (BRUTO): ${steadyStats.rawEventCount} evento(s), ` +
                    `cobertura ${(steadyStats.rawCoverageRatio * 100).toFixed(1)}%`);
                log.info(`[${testFile}#${iteration}] STEADY (FILTRADO): ${steadyStats.filteredEventCount} artefato(s) ` +
                    `| descartados ${steadyStats.discardedNoiseCount} (${steadyStats.discardedNoiseMs}ms)`);
                log.info(`[${testFile}#${iteration}] STEADY: pretoREAL=${steadyStats.trueBlackMs}ms ` +
                    `(${(steadyStats.trueBlackRatio * 100).toFixed(1)}%) ` +
                    `escura=${steadyStats.darkSceneMs}ms (${(steadyStats.darkRatio * 100).toFixed(1)}%) ` +
                    `freeze=${steadyStats.freezeMs}ms (${(steadyStats.freezeRatio * 100).toFixed(1)}%) ` +
                    `silêncio=${steadyStats.silenceMs}ms (${(steadyStats.silenceRatio * 100).toFixed(1)}%) ` +
                    `semCritico=${steadyStats.longestNonCriticalGapMs}ms`);
                steadyStats.events.forEach(ev => {
                    log.debug(`[${testFile}#${iteration}]   ${ev.kind.padEnd(11)} +${ev.offset_ms}ms ` +
                        `dur=${ev.duration_ms}ms blackness=${ev.blackness}%` +
                        (ev.resolved_in_grace ? ' [RESOLVEU NA CONFIRMAÇÃO]' : ''));
                });

                let audioState = { known: false, silent: null, via: 'not-checked' };
                let audioProbe = { conclusive: false, hadAudio: null, method: 'not-run' };
                if (steadyStats.audioEventCount === 0 && !openAudioOk) {
                    audioState = await readSilenceState();
                    if (!audioState.known && VOD_CFG.audioMuteProbe) {
                        log.info(`[${testFile}#${iteration}] Sonda ativa de áudio (mute)...`);
                        audioProbe = await probeAudioByMute(VOD_CFG.audioMuteProbeTimeoutMs);
                    }
                }

                verdict = buildVerdict({
                    openPhase, introStats, steadyStats, audioProbe, audioState, openAudioOk, cfg: VOD_CFG
                });
            }
        }

    } catch (err) {
        log.error(`[${testFile}#${iteration}] Erro fatal: ${err.stack || err}`);
        verdict = {
            success: false, resultCode: -99, diagnosis: 'EXCEPTION',
            open: { status: 'EXCEPTION', timeToPlayMs: null, startupBlackMs: null },
            intro: introStats,
            video: { ok: false, reason: `Exceção: ${err.message}` },
            audio: { ok: false, reason: 'Não avaliado', confidence: 'unknown' },
            warnings: [], timeToPlayMs: null, needsVisualReview: false
        };
    }

    verdict.iteration = iteration;
    verdict.startedAt = startedAt.toISOString();
    verdict.finishedAt = new Date().toISOString();
    verdict.sequence = (VOD_CFG.navigationSequence || []).map(s => s.key).join(' > ') +
        (VOD_CFG.triggerStep ? ` >> ${VOD_CFG.triggerStep.key}` : '');

    vodResults.passed = verdict.success;
    vodResults.add({
        datetime: verdict.finishedAt, sequence: verdict.sequence,
        status: verdict.success ? 'SUCESSO' : (verdict.needsVisualReview ? 'REVISAR' : 'ERRO'),
        diagnosis: verdict.diagnosis,
        open_status: verdict.open ? verdict.open.status : '',
        time_to_play_ms: verdict.timeToPlayMs,
        startup_black_ms: verdict.open ? verdict.open.startupBlackMs : null,
        intro_emerged: introStats.emerged ? 'SIM' : 'NAO',
        intro_wait_ms: introStats.waitedMs,
        intro_black_ms: introStats.blackMs,
        video: verdict.video.ok ? 'OK (moving)' : 'FALHA',
        video_detail: verdict.video.reason,
        audio: verdict.audio.ok ? 'OK (com áudio)' : 'FALHA',
        audio_confidence: verdict.audio.confidence,
        audio_detail: verdict.audio.reason,
        boundary_grace: steadyStats.boundaryKind
            ? (steadyStats.boundaryResolved ? 'RESOLVEU' : 'PERSISTIU') : '',
        boundary_artifact_ms: steadyStats.boundaryArtifactMs,
        raw_events: steadyStats.rawEventCount,
        filtered_artifacts: steadyStats.filteredEventCount,
        noise_discarded: steadyStats.discardedNoiseCount,
        steady_true_black_pct: verdict.video.trueBlackPercent,
        steady_dark_pct: verdict.video.darkScenePercent,
        steady_freeze_pct: verdict.video.freezePercent,
        steady_silence_pct: verdict.audio.silencePercent,
        longest_no_critical_ms: verdict.video.longestNonCriticalGapMs,
        critical_events: verdict.video.criticalEventCount
    });

    vodResults.addIntro({
        datetime: verdict.finishedAt,
        emerged: introStats.emerged ? 'SIM' : 'NAO',
        waited_ms: introStats.waitedMs, artifacts: introStats.artifactCount,
        black_ms: introStats.blackMs, black_pct: (introStats.blackRatio * 100).toFixed(1),
        blackness_min: introStats.blacknessMin != null ? introStats.blacknessMin.toFixed(2) : '',
        blackness_max: introStats.blacknessMax != null ? introStats.blacknessMax.toFixed(2) : '',
        blackness_range_pp: introStats.blacknessRange.toFixed(1),
        content_varied: introStats.contentVaried ? 'SIM' : 'NAO',
        audio_active: introStats.audioActive ? 'SIM' : 'NAO'
    });

    (steadyStats.events || []).forEach(ev => vodResults.addArtifact({
        datetime: verdict.finishedAt, kind: ev.kind, mnemonic: ev.mnemonic,
        offset_ms: ev.offset_ms, duration_ms: ev.duration_ms,
        true_duration_ms: ev.true_duration_ms,
        resolved_in_grace: ev.resolved_in_grace, blackness: ev.blackness
    }));
    (steadyStats.rawEvents || []).forEach(ev => vodResults.addRaw({
        datetime: verdict.finishedAt, kind: ev.kind, mnemonic: ev.mnemonic,
        offset_ms: ev.offset_ms, duration_ms: ev.duration_ms, blackness: ev.blackness,
        noise: ev.duration_ms < VOD_CFG.minArtifactDurationMs ? 'SIM' : ''
    }));
    (allEvidence || []).forEach(sh => vodResults.addEvidence({
        datetime: verdict.finishedAt, type: 'Screenshot',
        file: sh.filename, note: sh.note || sh.label, path: sh.fullPath
    }));

    if (!verdict.success) {
        try {
            const assetUrl = await results.createAsset(`${VOD_CFG.assetTitle} - ${verdict.diagnosis}`, 3);
            verdict.assetUrl = assetUrl;
            vodResults.addEvidence({
                datetime: verdict.finishedAt, type: 'NDP asset',
                file: '', note: '', path: assetUrl
            });
        } catch (err) {
            log.warn(`[${testFile}#${iteration}] Asset não criado: ${err.message}`);
        }
    }

    log.info('==================== RESULTADO VOD ====================');
    log.info(` Sequência .............: ${verdict.sequence}`);
    log.info(` Status geral ..........: ${verdict.success ? '✅ CONCLUÍDO COM SUCESSO'
        : (verdict.needsVisualReview ? '🔍 REVISAR (evidência visual)' : '❌ ERRO')}`);
    log.info(` Diagnóstico ...........: ${verdict.diagnosis}`);
    log.info(' --- FASE 1: ABERTURA ---');
    log.info(`  Status ...............: ${verdict.open ? verdict.open.status : '-'}`);
    log.info(`  Time to play .........: ${verdict.timeToPlayMs !== null ? verdict.timeToPlayMs + ' ms' : 'n/a'}`);
    log.info(`  Preto de carregamento : ${verdict.open ? verdict.open.startupBlackMs : '-'} ms (esperado)`);
    log.info(' --- FASE 2A: INTRO / ABERTURA DO FILME ---');
    log.info(`  Conteúdo emergiu .....: ${introStats.emerged ? '✅ SIM' : '❌ NÃO'} ` +
        `(após ${introStats.waitedMs} ms)`);
    log.info(`  Artefatos de intro ...: ${introStats.artifactCount} ` +
        `(${introStats.blackMs} ms — TOLERADOS)`);
    if (introStats.blacknessMin != null) {
        log.info(`  Blackness na intro ...: ${introStats.blacknessMin.toFixed(1)}% – ` +
            `${introStats.blacknessMax.toFixed(1)}% ` +
            `(variação ${introStats.blacknessRange.toFixed(1)} p.p. → ` +
            `${introStats.contentVaried ? 'conteúdo mudando' : 'praticamente constante'})`);
    }
    log.info(`  Áudio na intro .......: ${introStats.audioActive ? '✅ ATIVO' : '❌ SILENCIOSO'}`);
    log.info(' --- FASE 2B: PLAYBACK AVALIADO ---');
    log.info(`  Janela observada .....: ${steadyStats.windowMs} ms`);
    log.info(`  Eventos brutos .......: ${steadyStats.rawEventCount} ` +
        `(cobertura ${(steadyStats.rawCoverageRatio * 100).toFixed(1)}%)`);
    log.info(`  Ruído descartado .....: ${steadyStats.discardedNoiseCount} evento(s), ` +
        `${steadyStats.discardedNoiseMs} ms`);
    log.info(`  Artefatos REAIS ......: ${steadyStats.filteredEventCount} ` +
        `(${steadyStats.criticalEventCount} crítico(s))`);
    if (steadyStats.boundaryKind) {
        log.info(' --- FASE 3: CONFIRMAÇÃO DE BORDA ---');
        log.info(`  Artefato no corte ....: ${steadyStats.boundaryKind} de ${steadyStats.boundaryArtifactMs} ms`);
        log.info(`  Resultado ............: ${steadyStats.boundaryResolved
            ? '✅ RESOLVEU — era cena, não falha' : '❌ PERSISTIU — falha confirmada'}`);
    }
    log.info(' --- VEREDITO ---');
    log.info(`  Vídeo ................: ${verdict.video.ok ? '✅ OK' : '❌ FALHA'} - ${verdict.video.reason}`);
    log.info(`  Áudio ................: ${verdict.audio.ok ? '✅ OK' : '❌ FALHA'} ` +
        `[${verdict.audio.confidence}] - ${verdict.audio.reason}`);
    log.info(`  Preto REAL ...........: ${verdict.video.trueBlackPercent || 0}%`);
    log.info(`  Cenas escuras ........: ${verdict.video.darkScenePercent || 0}%`);
    log.info(`  Congelamento .........: ${verdict.video.freezePercent || 0}%`);
    log.info(`  Silêncio .............: ${verdict.audio.silencePercent || 0}%`);
    log.info(`  Sem preto/freeze .....: ${verdict.video.longestNonCriticalGapMs || 0} ms <- critério real`);
    log.info(`  Evidências ...........: ${allEvidence.length} snapshot(s)`);
    (verdict.warnings || []).forEach(wm => log.warn(` ⚠️  ${wm}`));
    if (verdict.assetUrl) log.info(` Evidência .............: ${verdict.assetUrl}`);
    log.info('=======================================================');

    if (typeof Navigation !== 'undefined' && Navigation.addResults) {
        Navigation.addResults(vodResults);
    }
    return verdict;
}

module.exports = main();
