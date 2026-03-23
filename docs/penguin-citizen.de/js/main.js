// Generate animated starfield
function createStarfield() {
  const starfield = document.getElementById('starfield')
  const starCount = 150

  for (let i = 0; i < starCount; i++) {
    const star = document.createElement('div')
    star.className = 'star'

    const size = Math.random() * 2 + 1
    const x = Math.random() * 100
    const y = Math.random() * 100
    const duration = Math.random() * 3 + 2
    const baseOpacity = Math.random() * 0.5 + 0.2

    star.style.cssText = `
      width: ${size}px;
      height: ${size}px;
      left: ${x}%;
      top: ${y}%;
      --duration: ${duration}s;
      --base-opacity: ${baseOpacity};
    `

    starfield.appendChild(star)
  }
}

// Scroll animations
function handleScrollAnimations() {
  const elements = document.querySelectorAll('.animate-on-scroll')

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible')
        }
      })
    },
    { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }
  )

  elements.forEach((el) => observer.observe(el))
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  createStarfield()
  handleScrollAnimations()
})
