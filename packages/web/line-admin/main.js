const API_BASE =
  window.location.protocol === "file:" ? "http://localhost:18787" : "";

const elements = {
  statusMessage: document.getElementById("status-message"),
  refreshUsersButton: document.getElementById("refresh-users-button"),
  usersTableBody: document.getElementById("users-table-body"),
  upsertUserForm: document.getElementById("upsert-user-form"),
  userIdInput: document.getElementById("user-id-input"),
  nameInput: document.getElementById("name-input"),
  phoneInput: document.getElementById("phone-input"),
  lineUserIdInput: document.getElementById("line-user-id-input"),
  saveUserButton: document.getElementById("save-user-button"),
  resetFormButton: document.getElementById("reset-form-button"),
};

const state = {
  users: [],
};

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function setStatus(message, tone = "info") {
  elements.statusMessage.textContent = message || "";
  elements.statusMessage.dataset.tone = tone;
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload.error || `GET ${path} failed (${response.status})`);
  }
  return payload;
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload.error || payload.status || `POST ${path} failed (${response.status})`);
  }
  return payload;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function renderUsersTable() {
  elements.usersTableBody.innerHTML = "";
  if (!Array.isArray(state.users) || state.users.length === 0) {
    const emptyRow = document.createElement("tr");
    emptyRow.innerHTML = `<td colspan="6">ユーザーはまだ登録されていません。</td>`;
    elements.usersTableBody.appendChild(emptyRow);
    return;
  }

  state.users.forEach((user) => {
    const tr = document.createElement("tr");
    const isRegistered = Boolean(user?.registration?.isRegistered);
    const badgeClass = isRegistered ? "la-badge la-badge-ok" : "la-badge la-badge-warn";
    const badgeLabel = isRegistered ? "登録済み" : "未登録";
    tr.innerHTML = `
      <td>${user.id || "-"}</td>
      <td>${user.name || "-"}</td>
      <td>${user.normalizedPhoneE164 || "-"}</td>
      <td>${user.lineUserId || "-"}</td>
      <td><span class="${badgeClass}">${badgeLabel}</span></td>
      <td><button class="la-mini-button" type="button" data-user-id="${user.id}">編集</button></td>
    `;
    elements.usersTableBody.appendChild(tr);
  });

  elements.usersTableBody.querySelectorAll("button[data-user-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const userId = normalizeText(button.getAttribute("data-user-id"));
      const target = state.users.find((user) => user.id === userId);
      if (!target) {
        return;
      }
      elements.userIdInput.value = target.id || "";
      elements.nameInput.value = target.name || "";
      elements.phoneInput.value = target.normalizedPhoneE164 || "";
      elements.lineUserIdInput.value = target.lineUserId || "";
      setStatus(`ユーザー ${target.id} を編集中です。`, "info");
    });
  });
}

async function loadUsers() {
  const payload = await apiGet("/api/admin/users");
  state.users = Array.isArray(payload.users) ? payload.users : [];
  renderUsersTable();
}

function resetForm() {
  elements.userIdInput.value = "";
  elements.nameInput.value = "";
  elements.phoneInput.value = "";
  elements.lineUserIdInput.value = "";
}

async function submitUpsertUser(event) {
  event.preventDefault();
  const userId = normalizeText(elements.userIdInput.value);
  const name = normalizeText(elements.nameInput.value);
  const phoneNumber = normalizeText(elements.phoneInput.value);
  const lineUserId = normalizeText(elements.lineUserIdInput.value);

  if (!name || !phoneNumber) {
    setStatus("名前と電話番号は必須です。", "warn");
    return;
  }

  elements.saveUserButton.disabled = true;
  try {
    const payload = await apiPost("/api/admin/users/upsert", {
      ...(userId ? { userId } : {}),
      ...(lineUserId ? { lineUserId } : {}),
      name,
      phoneNumber,
    });
    state.users = Array.isArray(payload.users) ? payload.users : state.users;
    renderUsersTable();
    resetForm();
    setStatus("利用者情報を保存しました。", "ok");
  } catch (error) {
    setStatus(`保存に失敗しました: ${getErrorMessage(error)}`, "error");
  } finally {
    elements.saveUserButton.disabled = false;
  }
}

function registerEvents() {
  elements.refreshUsersButton.addEventListener("click", () => {
    loadUsers()
      .then(() => setStatus("利用者一覧を更新しました。", "ok"))
      .catch((error) => setStatus(`更新に失敗しました: ${getErrorMessage(error)}`, "error"));
  });

  elements.upsertUserForm.addEventListener("submit", (event) => {
    submitUpsertUser(event);
  });

  elements.resetFormButton.addEventListener("click", () => {
    resetForm();
    setStatus("フォームをクリアしました。", "info");
  });
}

async function bootstrap() {
  registerEvents();
  try {
    await loadUsers();
    setStatus("利用者一覧を読み込みました。", "ok");
  } catch (error) {
    setStatus(`初期化に失敗しました: ${getErrorMessage(error)}`, "error");
  }
}

bootstrap();
