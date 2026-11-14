'use strict';
/**
 * presets.js — Sampling-Presets, gemappt auf echte llama-server-Flags.
 * Werte basieren auf gängigen Empfehlungen für instruct-tuned Modelle.
 */

const PRESETS = [
  {
    id: 'balanced',
    name: 'Balanced',
    icon: '⚖️',
    description: 'Standard für Alltag, Fragen und Erklärungen. Guter Mix aus Fakten und Formulierung.',
    sampling: {
      temp: 0.7, topK: 40, topP: 0.92, minP: 0.05,
      repeatPenalty: 1.1, repeatLastN: 64, presencePenalty: 0, frequencyPenalty: 0,
      dryMultiplier: 0, xtcProbability: 0, seed: -1,
      samplers: 'penalties;dry;top_k;top_p;min_p;temperature',
    },
    systemPrompt: '',
  },
  {
    id: 'creative',
    name: 'Kreativ',
    icon: '🎨',
    description: 'Mehr Vielfalt und überraschende Formulierungen — für Geschichten, Ideen, Brainstorming.',
    sampling: {
      temp: 1.05, topK: 80, topP: 0.96, minP: 0.02,
      repeatPenalty: 1.03, repeatLastN: 128, presencePenalty: 0.1, frequencyPenalty: 0.05,
      dryMultiplier: 0.8, dryBase: 1.75, dryAllowedLength: 2, dryPenaltyLastN: 128,
      xtcProbability: 0.4, xtcThreshold: 0.15, seed: -1,
      samplers: 'penalties;dry;top_k;top_p;min_p;xtc;temperature',
    },
    systemPrompt: '',
  },
  {
    id: 'deterministic',
    name: 'Deterministisch',
    icon: '🎯',
    description: 'Greedy-Decoding: gleiche Frage → gleiche Antwort. Für Fakten, Extraktion, Tests.',
    sampling: {
      temp: 0.0, topK: 1, topP: 1.0, minP: 0.0,
      repeatPenalty: 1.0, repeatLastN: 64, presencePenalty: 0, frequencyPenalty: 0,
      dryMultiplier: 0, xtcProbability: 0, seed: 42,
      samplers: 'top_k;temperature',
    },
    systemPrompt: 'Antworte präzise, sachlich und ohne Ausschmückung.',
  },
  {
    id: 'code',
    name: 'Code / Reasoning',
    icon: '💻',
    description: 'Kühles Sampling mit Wiederholungsbremse — für Programmierung, Mathe und Logik.',
    sampling: {
      temp: 0.2, topK: 20, topP: 0.95, minP: 0.05,
      repeatPenalty: 1.05, repeatLastN: 256, presencePenalty: 0, frequencyPenalty: 0,
      dryMultiplier: 0.5, dryBase: 1.75, dryAllowedLength: 2, dryPenaltyLastN: 256,
      xtcProbability: 0, seed: -1,
      samplers: 'penalties;dry;top_k;top_p;min_p;temperature',
    },
    systemPrompt: 'Du bist ein präziser Programmier- und Analyseassistent. Gib vollständigen, lauffähigen Code aus und erkläre knapp.',
  },
];

/** Sampling-Objekt → llama-server-Argumente */
function samplingArgs(sampling = {}) {
  const args = [];
  const push = (flag, value) => {
    if (value === undefined || value === null || value === '') return;
    args.push(flag, String(value));
  };
  push('--temp', sampling.temp);
  push('--top-k', sampling.topK);
  push('--top-p', sampling.topP);
  push('--min-p', sampling.minP);
  push('--top-n-sigma', sampling.topNSigma);
  push('--repeat-penalty', sampling.repeatPenalty);
  push('--repeat-last-n', sampling.repeatLastN);
  push('--presence-penalty', sampling.presencePenalty);
  push('--frequency-penalty', sampling.frequencyPenalty);
  if (sampling.dryMultiplier) {
    push('--dry-multiplier', sampling.dryMultiplier);
    push('--dry-base', sampling.dryBase ?? 1.75);
    push('--dry-allowed-length', sampling.dryAllowedLength ?? 2);
    push('--dry-penalty-last-n', sampling.dryPenaltyLastN ?? 64);
  }
  if (sampling.xtcProbability) {
    push('--xtc-probability', sampling.xtcProbability);
    push('--xtc-threshold', sampling.xtcThreshold ?? 0.1);
  }
  if (sampling.samplers) push('--samplers', sampling.samplers);
  push('--seed', sampling.seed ?? -1);
  return args;
}

function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

module.exports = { PRESETS, getPreset, samplingArgs };
