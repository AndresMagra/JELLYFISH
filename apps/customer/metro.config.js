// Expo detecta el monorepo (npm workspaces) por sí solo; no hace falta configurar carpetas extra.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
