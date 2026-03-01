const container = document.getElementById("appsContainer");
const searchInput = document.getElementById("searchInput");

function renderApps(apps) {
  container.innerHTML = "";

  apps.forEach(app => {
    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <h3>${app.title}</h3>
      <p>${app.description}</p>
      <a href="${app.dir}/index.html" target="_blank">Open</a>
    `;

    container.appendChild(card);
  });
}

function searchApps(query) {
  const lower = query.toLowerCase();

  return APPS.filter(app =>
    app.title.toLowerCase().includes(lower) ||
    app.description.toLowerCase().includes(lower)
  );
}

searchInput.addEventListener("input", (e) => {
  renderApps(searchApps(e.target.value));
});

const gridBtn = document.getElementById("gridBtn");
const listBtn = document.getElementById("listBtn");

gridBtn.addEventListener("click", () => {
  container.classList.remove("list");
  container.classList.add("grid");
  gridBtn.classList.add("active");
  listBtn.classList.remove("active");
});

listBtn.addEventListener("click", () => {
  container.classList.remove("grid");
  container.classList.add("list");
  listBtn.classList.add("active");
  gridBtn.classList.remove("active");
});

renderApps(APPS);