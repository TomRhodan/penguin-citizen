// Handbook - Dynamic sidebar TOC and utilities
(function () {
  const chapters = [
    { href: 'index.html', title: 'Overview', titleDe: 'Uebersicht' },
    { href: 'getting-started.html', title: 'Getting Started', titleDe: 'Erste Schritte' },
    { href: 'dashboard.html', title: 'Dashboard', titleDe: 'Dashboard' },
    { href: 'launching.html', title: 'Launching the Game', titleDe: 'Spiel starten' },
    { href: 'installation.html', title: 'Installation', titleDe: 'Installation' },
    { href: 'wine-runners.html', title: 'Wine Runners', titleDe: 'Wine Runners' },
    { href: 'profiles.html', title: 'Profiles', titleDe: 'Profile' },
    { href: 'keybindings.html', title: 'Keybindings', titleDe: 'Tastenbelegung' },
    { href: 'usercfg.html', title: 'Graphics Settings', titleDe: 'Grafikeinstellungen' },
    { href: 'localization.html', title: 'Localization', titleDe: 'Lokalisierung' },
    { href: 'storage.html', title: 'Storage', titleDe: 'Speicherverwaltung' },
    { href: 'settings.html', title: 'Settings', titleDe: 'Einstellungen' },
    { href: 'troubleshooting.html', title: 'Troubleshooting', titleDe: 'Fehlerbehebung' }
  ]

  function getCurrentPage () {
    var path = window.location.pathname
    var filename = path.substring(path.lastIndexOf('/') + 1) || 'index.html'
    return filename
  }

  function isGerman () {
    return window.location.pathname.indexOf('/de/') !== -1
  }

  function renderSidebar () {
    var container = document.getElementById('handbook-sidebar-nav')
    if (!container) return

    var currentPage = getCurrentPage()
    var de = isGerman()

    var html = ''
    for (var i = 0; i < chapters.length; i++) {
      var ch = chapters[i]
      var isActive = ch.href === currentPage
      var title = de ? ch.titleDe : ch.title
      html += '<li><a href="' + ch.href + '"' + (isActive ? ' class="active"' : '') + '>' + title + '</a></li>'
    }
    container.innerHTML = html
  }

  function initMobileToggle () {
    var toggle = document.getElementById('handbook-mobile-toggle')
    var sidebar = document.getElementById('handbook-sidebar')
    if (!toggle || !sidebar) return

    toggle.addEventListener('click', function () {
      sidebar.classList.toggle('open')
      toggle.classList.toggle('open')
    })
  }

  document.addEventListener('DOMContentLoaded', function () {
    renderSidebar()
    initMobileToggle()
  })
})()
