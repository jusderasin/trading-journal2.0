// scripts/generate-report.js
// Script exécuté par GitHub Actions pour générer et envoyer les rapports IA

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import WebSocket from 'ws';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PERIOD = process.env.PERIOD || 'week'; // week | month | year

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  global: { fetch },
  realtime: { transport: WebSocket }
});

// ============================================
// CALCUL DE LA DATE DE DÉBUT SELON LA PÉRIODE
// ============================================
function getFromDate(period) {
  const now = new Date();
  switch (period) {
    case 'week':  { const d = new Date(); d.setDate(d.getDate() - 7);   return d.toISOString().split('T')[0]; }
    case 'month': { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().split('T')[0]; }
    case 'year':  { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().split('T')[0]; }
    default: return null;
  }
}

const PERIOD_LABELS = {
  week:  'Semaine du ' + new Date(Date.now() - 7*86400000).toLocaleDateString('fr-FR', { day:'numeric', month:'long' }) + ' au ' + new Date().toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' }),
  month: 'Mois de ' + new Date().toLocaleDateString('fr-FR', { month:'long', year:'numeric' }),
  year:  'Année ' + new Date().getFullYear()
};

// ============================================
// CALCUL DES STATISTIQUES
// ============================================
function calcStats(trades) {
  const wins   = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const bes    = trades.filter(t => t.result === 'BE');

  const wr = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 0;
  const totalWinR  = wins.reduce((s,t)   => s + parseFloat(t.rr||0), 0);
  const totalLossR = Math.abs(losses.reduce((s,t) => s + parseFloat(t.rr||0), 0));
  const pf = totalLossR > 0 ? (totalWinR / totalLossR).toFixed(2) : wins.length > 0 ? '∞' : '0.0';
  const totalR = trades.reduce((s,t) => s + parseFloat(t.rr||0), 0);
  const totalPnl = trades.reduce((s,t) => s + parseFloat(t.rr||0) * parseFloat(t.one_r||200), 0);
  const exp = trades.length > 0 ? totalR / trades.length : 0;

  let peak = 0, cumR = 0, maxDd = 0;
  [...trades].sort((a,b) => (a.date+(a.entry_time||'')).localeCompare(b.date+(b.entry_time||''))).forEach(t => {
    cumR += parseFloat(t.rr||0);
    if (cumR > peak) peak = cumR;
    const dd = peak - cumR;
    if (dd > maxDd) maxDd = dd;
  });

  const byDay = {};
  trades.forEach(t => {
    byDay[t.date] = (byDay[t.date]||0) + parseFloat(t.rr||0);
  });
  const greenDays = Object.values(byDay).filter(v => v > 0).length;
  const redDays   = Object.values(byDay).filter(v => v < 0).length;

  return { wr, pf, totalR: totalR.toFixed(1), totalPnl: totalPnl.toFixed(0), exp: exp.toFixed(2), maxDd: maxDd.toFixed(1), wins: wins.length, losses: losses.length, bes: bes.length, total: trades.length, greenDays, redDays };
}

// ============================================
// GÉNÉRATION DU RAPPORT VIA GEMINI
// ============================================
async function generateReport(user, trades, period) {
  const stats = calcStats(trades);
  const fromDate = getFromDate(period);

  // Agrégats
  const emotionCounts = {};
  const byHour = {};
  const bySetup = {};
  const negEmotions = ['FOMO', 'Impatient', 'Stressé', 'Revanche'];

  trades.forEach(t => {
    // Émotions
    let arr = [];
    try { arr = t.emotions ? (Array.isArray(t.emotions) ? t.emotions : JSON.parse(t.emotions)) : []; } catch {}
    arr.forEach(tag => { emotionCounts[tag] = (emotionCounts[tag]||0) + 1; });

    // Par heure
    if (t.entry_time) {
      const h = parseInt(t.entry_time.split(':')[0]);
      if (!byHour[h]) byHour[h] = { wins:0, losses:0, r:0 };
      byHour[h].r += parseFloat(t.rr||0);
      if (t.result === 'WIN') byHour[h].wins++;
      else if (t.result === 'LOSS') byHour[h].losses++;
    }

    // Par setup
    const s = t.scenario || 'Sans setup';
    if (!bySetup[s]) bySetup[s] = { wins:0, total:0, r:0 };
    bySetup[s].total++;
    bySetup[s].r += parseFloat(t.rr||0);
    if (t.result === 'WIN') bySetup[s].wins++;
  });

  const errorTrades = trades.filter(t => t.is_error);
  let maxLossStreak = 0, cur = 0;
  [...trades].sort((a,b) => (a.date+(a.entry_time||'')).localeCompare(b.date+(b.entry_time||''))).forEach(t => {
    if (t.result === 'LOSS') { cur++; maxLossStreak = Math.max(maxLossStreak, cur); } else cur = 0;
  });

  const name = user.display_name || user.username || 'Trader';
  const strategy = user.strategy || 'Non renseignée';

  const prompt = `Tu es un coach de trading professionnel expert. Voici les données complètes du trader ${name} sur la période "${PERIOD_LABELS[period]}".

# PROFIL TRADER
- Nom : ${name}
- Stratégie : ${strategy}
- Instrument principal : MNQ/NQ (Futures)

# STATISTIQUES CLÉS
- Total trades : ${stats.total} (${stats.wins}W · ${stats.losses}L · ${stats.bes}BE)
- Win Rate : ${stats.wr}%
- Profit Factor : ${stats.pf}
- Total R : ${stats.totalR}R
- PnL Total : $${stats.totalPnl}
- Max Drawdown : ${stats.maxDd}R
- Expectancy : ${stats.exp}R/trade
- Jours verts / rouges : ${stats.greenDays} / ${stats.redDays}

# PERFORMANCE PAR SETUP
${Object.entries(bySetup).map(([s,d]) => `- ${s} : ${d.total} trades, ${d.total>0?Math.round(d.wins/d.total*100):0}% WR, ${d.r>=0?'+':''}${d.r.toFixed(1)}R`).join('\n') || '- Aucun setup renseigné'}

# PERFORMANCE PAR HEURE (heure de Paris)
${Object.entries(byHour).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).map(([h,d]) => `- ${h}h : ${d.wins}W/${d.losses}L, ${d.r>=0?'+':''}${d.r.toFixed(1)}R`).join('\n') || '- Heures non renseignées'}

# ÉMOTIONS RESSENTIES
${Object.entries(emotionCounts).sort((a,b)=>b[1]-a[1]).map(([tag,count]) => `- ${tag} : ${count} fois (${negEmotions.includes(tag)?'⚠️ négatif':'✅ positif'})`).join('\n') || '- Aucune émotion renseignée'}

# ERREURS DE TRADING
- Trades marqués comme erreur : ${errorTrades.length} / ${stats.total}
${errorTrades.slice(0,5).map(t => `  · ${t.date} ${t.entry_time||''} ${t.direction} ${t.result} ${t.rr}R${t.notes?' — '+t.notes:''}`).join('\n')}

# SÉRIE MAX PERTES CONSÉCUTIVES : ${maxLossStreak}

---

Génère un rapport d'analyse de trading COMPLET, PROFESSIONNEL et PERSONNALISÉ en français pour ${name}. Structure ton rapport avec ces sections :

1. 📊 RÉSUMÉ EXÉCUTIF (3-4 phrases percutantes résumant la ${period==='week'?'semaine':period==='month'?'mois':'année'})
2. 💪 POINTS FORTS (ce qui marche, avec chiffres précis)
3. ⚠️ POINTS D'AMÉLIORATION (problèmes identifiés avec exemples précis)
4. 🕐 ANALYSE TEMPORELLE (meilleures/pires heures avec recommandations)
5. 🎯 ANALYSE PAR SETUP (quel setup performer, lequel éviter)
6. 🧠 ANALYSE PSYCHOLOGIQUE (émotions et leur impact)
7. 📈 RECOMMANDATIONS CONCRÈTES (3-5 actions à mettre en place immédiatement)
8. 🎯 OBJECTIF POUR LA PROCHAINE PÉRIODE

Sois direct, honnête et utilise des chiffres précis. Tu parles directement à ${name}.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.7 }
      })
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Erreur Gemini');
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ============================================
// ENVOI EMAIL VIA RESEND
// ============================================
async function sendEmail(toEmail, toName, reportText, period) {
  const periodEmoji = { week: '📊', month: '📈', year: '🏆' };
  const periodLabel = { week: 'Hebdomadaire', month: 'Mensuel', year: 'Annuel' };
  const subjectPeriod = PERIOD_LABELS[period];

  // Convertir le texte du rapport en HTML basique
  const reportHtml = reportText
    .split('\n')
    .map(line => {
      if (line.startsWith('# ') || line.match(/^[📊💪⚠️🕐🎯🧠📈🏆]/)) {
        return `<h2 style="color:#00c896;font-size:16px;margin:24px 0 8px;border-bottom:1px solid #1e2535;padding-bottom:6px">${line.replace(/^#+ /, '')}</h2>`;
      }
      if (line.startsWith('- ') || line.startsWith('· ')) {
        return `<li style="margin:4px 0;color:#b0bacf">${line.slice(2)}</li>`;
      }
      if (line.trim() === '') return '<br>';
      return `<p style="margin:6px 0;color:#b0bacf;line-height:1.6">${line}</p>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rapport TradingZone</title>
</head>
<body style="margin:0;padding:0;background:#040608;font-family:'Inter',Arial,sans-serif">
  <div style="max-width:680px;margin:0 auto;padding:32px 20px">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px">
      <div style="display:inline-block;background:#0c0f19;border:1px solid #161b28;border-radius:16px;padding:24px 32px">
        <div style="font-size:28px;margin-bottom:8px">${periodEmoji[period]}</div>
        <h1 style="margin:0;font-size:22px;font-weight:800;color:#e8edf5;letter-spacing:-0.5px">
          Rapport ${periodLabel[period]} TradingZone
        </h1>
        <p style="margin:8px 0 0;font-size:13px;color:#7a8599">${subjectPeriod}</p>
      </div>
    </div>

    <!-- Salutation -->
    <p style="font-size:15px;color:#b0bacf;margin-bottom:24px">
      Bonjour <strong style="color:#e8edf5">${toName}</strong> 👋<br>
      Voici ton rapport de trading personnalisé généré par intelligence artificielle.
    </p>

    <!-- Rapport -->
    <div style="background:#0c0f19;border:1px solid #161b28;border-radius:12px;padding:28px;margin-bottom:24px">
      ${reportHtml}
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://jusderasin.github.io/trading-journal2.0/"
         style="display:inline-block;background:#00c896;color:#000;font-weight:700;font-size:14px;padding:14px 28px;border-radius:10px;text-decoration:none">
        📱 Ouvrir TradingZone
      </a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;border-top:1px solid #161b28;padding-top:20px">
      <p style="font-size:11px;color:#4a5568;margin:0">
        TradingZone · Rapport généré automatiquement par IA<br>
        Ce rapport est personnalisé basé sur tes données de trading réelles
      </p>
    </div>

  </div>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'TradingZone <onboarding@resend.dev>',
      to: [toEmail],
      subject: `${periodEmoji[period]} Ton rapport ${periodLabel[period]} TradingZone — ${subjectPeriod}`,
      html
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || 'Erreur Resend');
  return data;
}

// ============================================
// SCRIPT PRINCIPAL
// ============================================
async function main() {
  console.log(`\n🚀 Démarrage génération rapports — Période : ${PERIOD}`);
  const fromDate = getFromDate(PERIOD);
  console.log(`📅 Période : ${PERIOD_LABELS[PERIOD]} (depuis ${fromDate || 'le début'})`);

  // Récupérer tous les utilisateurs avec profil public et email
  const { data: profiles, error: profErr } = await sb.from('profiles').select('*');
  if (profErr) { console.error('❌ Erreur récupération profils:', profErr.message); process.exit(1); }

  console.log(`👥 ${profiles.length} profil(s) trouvé(s)`);

  let sent = 0, errors = 0;

  for (const profile of profiles) {
    try {
      // Récupérer l'email de l'utilisateur depuis auth.users
      const { data: { user }, error: userErr } = await sb.auth.admin.getUserById(profile.id);
      if (userErr || !user?.email) {
        console.log(`  ⚠️  ${profile.username || profile.id} — email non trouvé, ignoré`);
        continue;
      }

      const email = user.email;
      const name = profile.display_name || profile.username || email.split('@')[0];

      // Récupérer les trades de la période
      let q = sb.from('trades').select('*').eq('user_id', profile.id).order('date').order('entry_time');
      if (fromDate) q = q.gte('date', fromDate);
      const { data: trades, error: tradesErr } = await q;

      if (tradesErr) {
        console.log(`  ⚠️  ${name} — erreur trades: ${tradesErr.message}`);
        continue;
      }

      if (!trades || trades.length === 0) {
        console.log(`  📭  ${name} — aucun trade sur la période, email ignoré`);
        continue;
      }

      console.log(`  📊  ${name} (${email}) — ${trades.length} trade(s), génération rapport...`);

      // Générer le rapport IA
      const reportText = await generateReport(profile, trades, PERIOD);
      if (!reportText) { console.log(`  ❌  ${name} — rapport vide`); errors++; continue; }

      // Envoyer l'email
      await sendEmail(email, name, reportText, PERIOD);
      console.log(`  ✅  ${name} — email envoyé avec succès`);
      sent++;

      // Pause entre chaque utilisateur pour éviter les rate limits
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.error(`  ❌  Erreur pour profil ${profile.id}:`, err.message);
      errors++;
    }
  }

  console.log(`\n✅ Terminé — ${sent} email(s) envoyé(s), ${errors} erreur(s)`);
  if (errors > 0) process.exit(1);
}

main().catch(err => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});
