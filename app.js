const REPO = 'Studycare1/BiologyGuess';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

const els = {
  library: document.getElementById('library'),
  status: document.getElementById('libraryStatus'),
  empty: document.getElementById('emptyState'),
  reader: document.getElementById('reader'),
  img: document.getElementById('pageImage'),
  title: document.getElementById('readerTitle'),
  counter: document.getElementById('pageCounter'),
  slider: document.getElementById('pageSlider'),
  prev: document.getElementById('prevBtn'),
  next: document.getElementById('nextBtn'),
  close: document.getElementById('closeReader'),
};

let currentBook = null;
let currentPage = 1;

// Load Library
async function loadLibrary() {
  try {
    els.status.textContent = 'लाइब्रेरी लोड हो रही है...';
    const res = await fetch(`${RAW_BASE}books/index.json?v=${Date.now()}`);
    
    if (!res.ok) throw new Error(`HTTP ${res.status} - index.json नहीं मिली`);
    
    const data = await res.json();
    const books = data.books || [];
    
    els.library.innerHTML = '';
    if (books.length === 0) {
      els.empty.style.display = 'block';
      els.status.textContent = '';
      return;
    }

    els.empty.style.display = 'none';
    els.status.textContent = `${books.length} किताबें मिलीं`;
    
    books.forEach(book => {
      const card = document.createElement('div');
      card.className = 'book-card';
      card.innerHTML = `
        <div class="cover"><img src="${RAW_BASE}${book.cover}" alt="cover"></div>
        <div class="meta">
          <h3>${book.title}</h3>
          <p>${book.author || 'Unknown'}</p>
        </div>
      `;
      card.onclick = () => openBook(book);
      els.library.appendChild(card);
    });
  } catch (err) {
    els.status.textContent = 'Error: ' + err.message;
    els.status.style.color = 'red';
  }
}

// Open Book
function openBook(book) {
  currentBook = book;
  currentPage = 1;
  els.title.textContent = book.title;
  els.reader.style.display = 'grid';
  document.body.style.overflow = 'hidden';
  
  els.slider.max = book.pages;
  showPage(1);
}

// Show Page
function showPage(num) {
  if (!currentBook) return;
  if (num < 1) num = 1;
  if (num > currentBook.pages) num = currentBook.pages;
  
  currentPage = num;
  const pad = currentBook.pad || 3;
  const filename = `page-${String(num).padStart(pad, '0')}.${currentBook.ext}`;
  const url = `${RAW_BASE}books/${currentBook.slug}/${filename}`;
  
  els.img.src = url;
  els.counter.textContent = `${num} / ${currentBook.pages}`;
  els.slider.value = num;
  
  els.prev.disabled = num === 1;
  els.next.disabled = num === currentBook.pages;
}

// Events
els.close.onclick = () => { els.reader.style.display = 'none'; document.body.style.overflow = ''; };
els.prev.onclick = () => showPage(currentPage - 1);
els.next.onclick = () => showPage(currentPage + 1);
els.slider.oninput = (e) => showPage(Number(e.target.value));

// Zoom
let isZoomed = false;
document.getElementById('zoomBtn').onclick = () => {
  isZoomed = !isZoomed;
  els.img.style.transform = isZoomed ? 'scale(1.5)' : 'scale(1)';
  els.img.style.cursor = isZoomed ? 'zoom-out' : 'zoom-in';
};

// Theme
document.getElementById('themeBtn').onclick = () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'dark' : 'light');
};

// Start
loadLibrary();
