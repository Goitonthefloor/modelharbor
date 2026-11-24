'use strict';
/* Pfade ohne Electron. Müssen mit app.getPath('userData') der Desktop-App
 * übereinstimmen, sonst sieht die CLI andere Modelle/Einstellungen als die App.
 * Reihenfolge: MODELHARBOR_HOME (Tests/Portable) → Plattform-Standard. */

const os = require('os');
const path = require('path');

const APP_DIR_NAME = 'ModelHarbor';

function userDataDir(env = process.env) {
  if (env.MODELHARBOR_HOME) return path.resolve(env.MODELHARBOR_HOME);
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_DIR_NAME);
}

module.exports = { APP_DIR_NAME, userDataDir };
