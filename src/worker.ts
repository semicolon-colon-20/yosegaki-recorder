interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_REF: string;
}

type Cell = {
  value: unknown;
};

type BoardResponse = {
  cells?: Cell[];
};

type GitHubFileResponse = {
  content: string;
  sha: string;
};

type Snapshot = {
  time: string;
  cells: unknown[];
};

const BOARD_URL = "https://yosegaki.suzaku-tools.workers.dev/api/board";

function toJstIso(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);

  return jst.toISOString().replace("Z", "+09:00");
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);

  let binary = "";

  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }

  return btoa(binary);
}

function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ""));

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

function githubHeaders(env: Env): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": "yosegaki-recorder",
  };
}

async function createSnapshot(): Promise<Snapshot> {
  const response = await fetch(BOARD_URL, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Board request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as BoardResponse;

  if (!Array.isArray(data.cells)) {
    throw new Error("Board response does not contain cells.");
  }

  return {
    time: toJstIso(new Date()),
    cells: data.cells.map((cell) => cell.value),
  };
}

async function getExistingFile(
  env: Env,
  path: string,
): Promise<{
  content: string;
  sha?: string;
}> {
  const url =
    `https://api.github.com/repos/` +
    `${env.GITHUB_REPOSITORY}/contents/` +
    `${path}?ref=${encodeURIComponent(env.GITHUB_REF)}`;

  const response = await fetch(url, {
    headers: githubHeaders(env),
  });

  if (response.status === 404) {
    return {
      content: "[]",
    };
  }

  if (!response.ok) {
    const body = await response.text();

    throw new Error(`GitHub read failed: ${response.status} ${body}`);
  }

  const file = (await response.json()) as GitHubFileResponse;

  return {
    content: decodeBase64(file.content),
    sha: file.sha,
  };
}

async function putFile(
  env: Env,
  path: string,
  content: string,
  sha?: string,
): Promise<Response> {
  const url =
    `https://api.github.com/repos/` +
    `${env.GITHUB_REPOSITORY}/contents/${path}`;

  return fetch(url, {
    method: "PUT",

    headers: githubHeaders(env),

    body: JSON.stringify({
      message: "Save board snapshot",
      content: encodeBase64(content),
      branch: env.GITHUB_REF,
      ...(sha ? { sha } : {}),
    }),
  });
}

function getOutputPath(snapshot: Snapshot): string {
  const date = snapshot.time.slice(0, 10);

  const hour = snapshot.time.slice(11, 13);

  return `data/${date}/${hour}.json`;
}

async function appendSnapshot(env: Env, snapshot: Snapshot): Promise<void> {
  const path = getOutputPath(snapshot);

  const serializedSnapshot = JSON.stringify(snapshot);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const existing = await getExistingFile(env, path);

    const snapshots = JSON.parse(existing.content) as Snapshot[];

    if (!Array.isArray(snapshots)) {
      throw new Error(`GitHub file is not a JSON array: ${path}`);
    }

    // 前回の PUT が実際には成功していた場合の
    // 重複保存を防ぐ
    if (snapshots.some((saved) => JSON.stringify(saved) === serializedSnapshot)) {
      console.log(`Snapshot already exists in ${path}`);

      return;
    }

    snapshots.push(snapshot);

    const response = await putFile(
      env,
      path,
      JSON.stringify(snapshots),
      existing.sha,
    );

    if (response.ok) {
      console.log(
        `Saved ${snapshot.cells.length} cells to ${path} at ${snapshot.time}`,
      );

      return;
    }

    if (response.status !== 409 && response.status !== 422) {
      const body = await response.text();

      throw new Error(`GitHub write failed: ${response.status} ${body}`);
    }

    console.log(`Concurrent update detected. Retry ${attempt}/3.`);
  }

  throw new Error("Could not update GitHub file after 3 attempts.");
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const snapshot = await createSnapshot();

    await appendSnapshot(env, snapshot);
  },
} satisfies ExportedHandler<Env>;
