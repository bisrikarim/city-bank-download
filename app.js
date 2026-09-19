/*
 * City Bank — page de téléchargement.
 *
 * LE SEUL ENDROIT À MODIFIER À CHAQUE NOUVELLE VERSION : les deux constantes
 * ci-dessous. Tous les boutons « Télécharger » de la page les reprennent.
 */
// Lien fixe : « latest » pointe toujours vers la dernière Release GitHub créée
// dans bisrikarim/city-bank-download. Une nouvelle version = une nouvelle
// Release avec un fichier nommé exactement city-bank.apk ; ce lien n'a pas à changer.
const APK_URL = 'https://github.com/bisrikarim/city-bank-download/releases/latest/download/city-bank.apk';
const APP_VERSION = '1.0.0'; // mobile/app.json -> expo.version

(function () {
  // Every download button points to the same file.
  document.querySelectorAll('.js-apk').forEach(function (link) {
    link.setAttribute('href', APK_URL);
  });
  document.querySelectorAll('.js-version').forEach(function (node) {
    node.textContent = 'Version ' + APP_VERSION;
  });
  document.querySelectorAll('.js-year').forEach(function (node) {
    node.textContent = String(new Date().getFullYear());
  });

  // On a computer, a QR code sends this very page to the phone. Hidden on
  // phones (nothing to scan from) and if the QR library could not load.
  var isDesktop = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1021px)').matches;
  var card = document.querySelector('.js-qr-card');
  var target = document.querySelector('.js-qr');
  if (!isDesktop || !card || !target || typeof window.QRCode !== 'function') return;

  try {
    new window.QRCode(target, {
      text: window.location.href.split('#')[0],
      width: 216,
      height: 216,
      colorDark: '#17392C',
      colorLight: '#FFFFFF',
      correctLevel: window.QRCode.CorrectLevel.M,
    });
    card.hidden = false;
  } catch (error) {
    // No QR code is better than a broken one.
  }
})();
