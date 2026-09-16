import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";

const FRAME_COUNT = 50;

// 記事用デバッグフラグ:
//   ?decode=naive|noflip|nomirror  デコード補正を意図的に外して症状を再現する
//   ?normals=flat                  スムーズ法線を作らずフラット法線のままにする
const _debugParams = new URLSearchParams(window.location.search);
const DECODE_MODE = _debugParams.get("decode") || "correct";
const NORMALS_MODE = _debugParams.get("normals") || "smooth";

/**
 * VAT ファイル (FBX メッシュ + EXR ポジションテクスチャ) を読み込み、
 * animation.json と同じ形式の animData を返す。
 *
 * animData: { vertexCount, frameCount, indices, uvs, positions, normals }
 */
export async function loadVATData(basePath) {
  const fbxLoader = new FBXLoader();
  const exrLoader = new EXRLoader();
  exrLoader.setDataType(THREE.FloatType);

  // FBX と Position EXR を並列ロード
  console.log("[VAT] loading FBX + EXR from:", basePath);
  const [fbxGroup, posTex] = await Promise.all([
    fbxLoader.loadAsync(basePath + "geo/vertex_animation_textures1_mesh.fbx"),
    exrLoader.loadAsync(basePath + "tex/vertex_animation_textures1_pos.exr"),
  ]);
  console.log("[VAT] FBX + EXR loaded");

  // FBX からメッシュを取得
  let fbxMesh = null;
  fbxGroup.traverse((child) => {
    if (child.isMesh && !fbxMesh) fbxMesh = child;
  });
  if (!fbxMesh) throw new Error("FBX にメッシュが見つかりません");

  const geo = fbxMesh.geometry;
  const posAttr = geo.getAttribute("position");
  const uvAttr = geo.getAttribute("uv");
  const indexAttr = geo.getIndex();
  const vertexCount = posAttr.count;

  console.log('posAttr.count:', posAttr.count);
  // VAT ルックアップ UV: FBXLoader は 2番目の UV を "uv1" として格納する
  const vatUvAttr = geo.getAttribute("uv2") || geo.getAttribute("uv1");

  console.log("[VAT] vertexCount:", vertexCount);
  console.log("[VAT] has index:", !!indexAttr, indexAttr ? "count=" + indexAttr.count : "");
  console.log("[VAT] has uv:", !!uvAttr, "has vatUv:", !!vatUvAttr);
  console.log("[VAT] geometry attributes:", Object.keys(geo.attributes));
  if (vatUvAttr) {
    console.log("[VAT] vatUv sample v0:", vatUvAttr.getX(0), vatUvAttr.getY(0));
    console.log("[VAT] vatUv sample v1:", vatUvAttr.getX(1), vatUvAttr.getY(1));
  }

  // インデックス配列
  // FBX末尾にVAT用ではないbboxダミーらしき2三角形(uv1 = 0,0)が入るので除外する。
  const indices = [];
  if (indexAttr) {
    for (let i = 0; i < indexAttr.count; i++) indices.push(indexAttr.getX(i));
  } else {
    for (let i = 0; i < vertexCount; i += 3) {
      const hasInvalidVatUv =
        vatUvAttr &&
        (
          (vatUvAttr.getX(i) === 0 && vatUvAttr.getY(i) === 0) ||
          (vatUvAttr.getX(i + 1) === 0 && vatUvAttr.getY(i + 1) === 0) ||
          (vatUvAttr.getX(i + 2) === 0 && vatUvAttr.getY(i + 2) === 0)
        );
      if (hasInvalidVatUv) continue;

      indices.push(i, i + 1, i + 2);
    }
  }

  // UV 配列（紙テクスチャマッピング用）
  const uvs = [];
  if (uvAttr) {
    for (let i = 0; i < uvAttr.count; i++) {
      uvs.push(uvAttr.getX(i), uvAttr.getY(i));
    }
  }

  // ===== EXR Position テクスチャからフレームデータを読み出す =====
  const posData = posTex.image.data; // Float32Array
  const texW = posTex.image.width;
  const texH = posTex.image.height;
  const channels = posData.length / (texW * texH); // 通常 4 (RGBA)

  console.log("[VAT] pos texture:", texW, "x", texH, "channels:", channels);
  console.log("[VAT] pos sample pixel[0]:", posData[0], posData[1], posData[2]);

  const rawFrameCount = FRAME_COUNT;
  let pointCount = vertexCount;

  if (vatUvAttr) {
    pointCount = 0;
    for (let v = 0; v < vertexCount; v++) {
      if (vatUvAttr.getX(v) === 0 && vatUvAttr.getY(v) === 0) continue;

      const col = Math.floor(vatUvAttr.getX(v) * texW);
      const row = Math.floor((1 - vatUvAttr.getY(v)) * texH);
      pointCount = Math.max(pointCount, row * texW + col + 1);
    }
  }

  // 1フレームが占める行数 (このアセットでは 3500ポイント ÷ 幅1024 → 4行)
  const rowsPerFrame = Math.ceil(pointCount / texW);

//  console.log("[VAT] pointCount:", pointCount, "rowsPerFrame:", rowsPerFrame, "rawFrameCount:", rawFrameCount);

  // 各頂点の VAT ポイント ID — 三角形スープ上で位置を共有する頂点は同じ ID になる。
  // デコードとスムーズ法線の計算の両方で使う。
  const vertexPointIds = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    let pointId;
    if (vatUvAttr) {
      if (vatUvAttr.getX(v) === 0 && vatUvAttr.getY(v) === 0) {
        pointId = 0;
      } else {
        const col = Math.floor(vatUvAttr.getX(v) * texW);
        const row = Math.floor((1 - vatUvAttr.getY(v)) * texH);
        pointId = row * texW + col;
      }
    } else {
      pointId = v;
    }
    vertexPointIds[v] = Math.max(0, Math.min(pointId, pointCount - 1));
  }
  console.log('vertexPointIds:', vertexPointIds);

  // 全フレームぶんの頂点の実座標 (レスト位置 + 変位を足し込み済み)。
  // [フレーム0の全頂点xyz][フレーム1の全頂点xyz]... と並ぶ1本の配列。
  // "raw" は静止フレームカット前の意で、カット後が positions になる。
  const rawPositions = new Float32Array(vertexCount * 3 * rawFrameCount);

  // アニメーションが使う総行数 (このアセットでは 4行 × 50フレーム = 200 = テクスチャ高さ)
  const totalRows = rawFrameCount * rowsPerFrame;

  for (let frame = 0; frame < rawFrameCount; frame++) {
    for (let v = 0; v < vertexCount; v++) {
      const pointId = vertexPointIds[v];

      // ポイント数がテクスチャ幅より多いので、1フレームは複数行に折り返して
      // 格納されている (このアセットでは 3500 ポイント → 1024×4行)。
      // ファイル自体はフレーム順に上から自然に並んでいるが、three.js の
      // EXRLoader が WebGL の UV 規約 (V=0 が下) に合わせてスキャンラインを
      // 上下反転して配列に格納するため、配列を画像のつもりで読むと全体が
      // ひっくり返っている。反転1回で戻す。
      const col = pointId % texW;
      const blockRow = Math.floor(pointId / texW);
      let row;
      if (DECODE_MODE === "naive") {
        // 記事用: 補正なしで論理行をそのまま読む (全部の癖が混ざった最初の破綻)
        row = frame * rowsPerFrame + blockRow;
      } else if (DECODE_MODE === "reversed") {
        // 記事用: 行順は直したがフレーム順が逆のまま
        // (症状①: フレーム0がきれいなくしゃ玉 / 最終フレームが平ら = 時間が逆さま)
        row = frame * rowsPerFrame + (rowsPerFrame - 1 - blockRow);
      } else if (DECODE_MODE === "noflip") {
        // 記事用: フレーム順だけ反転し、ブロック内の行順を直さない (症状②: 行ズレの裂け)
        row = (rawFrameCount - 1 - frame) * rowsPerFrame + blockRow;
      } else {
        row = totalRows - 1 - (frame * rowsPerFrame + blockRow);
      }
      const pixelIdx = (row * texW + col) * channels;
      const off = (frame * vertexCount + v) * 3;

      // ピクセルの値はレスト位置からの変位。X だけ符号が逆なので引き算で戻す。
      // FBX は無変換で届く (生ファイルの頂点値とロード後の値は一致する) のに対し、
      // EXR の変位は X 成分だけ反転した状態で書き出されている。左手系ターゲット
      // (Unity は FBX インポート時に X を反転する) に合わせた焼き込みと思われる。
      // (?decode=nomirror はこの補正を外して症状③を再現する)
      const xSign = DECODE_MODE === "nomirror" ? 1 : -1;
      rawPositions[off + 0] = posAttr.getX(v) + xSign * posData[pixelIdx + 0];
      rawPositions[off + 1] = posAttr.getY(v) + posData[pixelIdx + 1];
      rawPositions[off + 2] = posAttr.getZ(v) + posData[pixelIdx + 2];
    }
  }

  // ===== 動きのない先頭・末尾フレームをカット =====
  // 隣接フレーム間の最大頂点移動量を測り、静止している区間を除去する。
  const frameStride = vertexCount * 3;
  const frameDeltas = [];
  for (let frame = 0; frame < rawFrameCount - 1; frame++) {
    const a = frame * frameStride;
    const b = (frame + 1) * frameStride;
    let maxDelta = 0;
    for (let i = 0; i < frameStride; i++) {
      const d = Math.abs(rawPositions[a + i] - rawPositions[b + i]);
      if (d > maxDelta) maxDelta = d;
    }
    frameDeltas.push(maxDelta);
  }

  const MOTION_EPSILON = 1e-4;
  let firstMoving = frameDeltas.findIndex((d) => d > MOTION_EPSILON);
  let lastMoving = frameDeltas.length - 1;
  while (lastMoving >= 0 && frameDeltas[lastMoving] <= MOTION_EPSILON) {
    lastMoving--;
  }

  let frameCount = rawFrameCount;
  let positions = rawPositions;
  // 症状再現モードでは deltas が意味を持たないのでカットしない
  if (
    DECODE_MODE === "correct" &&
    (firstMoving > 0 || lastMoving < frameDeltas.length - 1)
  ) {
    if (firstMoving === -1) firstMoving = 0;
    // frameDeltas[i] は frame i → i+1 の移動量なので、i+1 まで残す
    frameCount = lastMoving + 2 - firstMoving;
    positions = rawPositions.slice(
      firstMoving * frameStride,
      (firstMoving + frameCount) * frameStride,
    );
    console.log(
      "[VAT] trimmed static frames:",
      "keep", firstMoving, "-", lastMoving + 1,
      "(", rawFrameCount, "->", frameCount, "frames )",
    );
  } else {
    console.log("[VAT] no static frames to trim");
  }
  console.log(
    "[VAT] frame deltas:",
    frameDeltas.map((d) => +d.toFixed(5)),
  );

  // ===== 計測対象の頂点 (FBX 末尾の bbox ダミー頂点を除外) =====
  const validVerts = [];
  for (let v = 0; v < vertexCount; v++) {
    if (vatUvAttr && vatUvAttr.getX(v) === 0 && vatUvAttr.getY(v) === 0) continue;
    validVerts.push(v);
  }

  // ===== 開いた状態(フレーム0)の XZ サイズを計測 =====
  // 開いた時に画面に対する大きさを合わせるのに使う
  let minFX = Infinity;
  let maxFX = -Infinity;
  let minFZ = Infinity;
  let maxFZ = -Infinity;
  for (const v of validVerts) {
    const x = positions[v * 3 + 0];
    const z = positions[v * 3 + 2];
    if (x < minFX) minFX = x;
    if (x > maxFX) maxFX = x;
    if (z < minFZ) minFZ = z;
    if (z > maxFZ) maxFZ = z;
  }
  const flat = { width: maxFX - minFX, depth: maxFZ - minFZ };
  console.log(
    "[VAT] flat size:",
    flat.width.toFixed(3), "x", flat.depth.toFixed(3),
  );

  // ===== くしゃくしゃ状態(最終フレーム)の中心と半径を計測 =====
  // 物理の衝突球と回転中心に使う。飛び出た角(外れ値)の影響を抑えるため
  // 半径は重心からの距離の90パーセンタイルを採用する。
  const lastOff = (frameCount - 1) * frameStride;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of validVerts) {
    cx += positions[lastOff + v * 3 + 0];
    cy += positions[lastOff + v * 3 + 1];
    cz += positions[lastOff + v * 3 + 2];
  }
  cx /= validVerts.length;
  cy /= validVerts.length;
  cz /= validVerts.length;

  const dists = new Float32Array(validVerts.length);
  for (let i = 0; i < validVerts.length; i++) {
    const v = validVerts[i];
    const dx = positions[lastOff + v * 3 + 0] - cx;
    const dy = positions[lastOff + v * 3 + 1] - cy;
    const dz = positions[lastOff + v * 3 + 2] - cz;
    dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  dists.sort();
  const crumple = {
    center: [cx, cy, cz],
    radius: dists[Math.floor(validVerts.length * 0.9)],
  };
  console.log(
    "[VAT] crumple center:",
    cx.toFixed(3), cy.toFixed(3), cz.toFixed(3),
    "radius:", crumple.radius.toFixed(3),
  );

  // ===== スムーズ法線を計算 =====
  // メッシュは頂点を共有しない三角形スープなので、computeVertexNormals では
  // 面法線のフラットシェーディングになり三角形の形が見えてしまう。
  //
  // そこでポイント単位で法線を作る:
  //   ① 三角形 (スープの並び順で決まっている) ごとに面法線を計算
  //   ② その面法線を、3つの角の頂点が所属するポイントの欄にそれぞれ加算
  //      (グリッド内部のポイントには周囲の約6三角形ぶんの票が集まる)
  //   ③ ポイントごとに平均 (正規化) したものが、そのポイントの法線になる
  //   ④ それを同じポイントに所属する全コピー頂点に配る
  // 同じ場所のコピー頂点が全員同じ法線を持つので、三角形の境目が陰影に出なくなる。
  const normals = new Float32Array(vertexCount * 3 * frameCount);
  const pointNormals = new Float32Array(pointCount * 3);

  for (let frame = 0; frame < frameCount; frame++) {
    const srcOff = frame * vertexCount * 3;

    // 記事用 (?normals=flat): ポイント平均をせず、面法線をそのまま3頂点に置く
    // = スープでの computeVertexNormals 相当。三角形が見える状態を再現する
    if (NORMALS_MODE === "flat") {
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 3;
        const b = indices[i + 1] * 3;
        const c = indices[i + 2] * 3;
        const ax = positions[srcOff + a];
        const ay = positions[srcOff + a + 1];
        const az = positions[srcOff + a + 2];
        const e1x = positions[srcOff + b] - ax;
        const e1y = positions[srcOff + b + 1] - ay;
        const e1z = positions[srcOff + b + 2] - az;
        const e2x = positions[srcOff + c] - ax;
        const e2y = positions[srcOff + c + 1] - ay;
        const e2z = positions[srcOff + c + 2] - az;
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        for (let k = 0; k < 3; k++) {
          const o = srcOff + indices[i + k] * 3;
          normals[o] = nx;
          normals[o + 1] = ny;
          normals[o + 2] = nz;
        }
      }
      continue;
    }

    pointNormals.fill(0);

    // 面法線 (面積重み付き) をポイントごとに加算
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3;
      const b = indices[i + 1] * 3;
      const c = indices[i + 2] * 3;

      const ax = positions[srcOff + a];
      const ay = positions[srcOff + a + 1];
      const az = positions[srcOff + a + 2];
      const e1x = positions[srcOff + b] - ax;
      const e1y = positions[srcOff + b + 1] - ay;
      const e1z = positions[srcOff + b + 2] - az;
      const e2x = positions[srcOff + c] - ax;
      const e2y = positions[srcOff + c + 1] - ay;
      const e2z = positions[srcOff + c + 2] - az;

      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;

      for (let k = 0; k < 3; k++) {
        const pid = vertexPointIds[indices[i + k]] * 3;
        pointNormals[pid] += nx;
        pointNormals[pid + 1] += ny;
        pointNormals[pid + 2] += nz;
      }
    }

    // 正規化
    for (let p = 0; p < pointCount; p++) {
      const o = p * 3;
      const len = Math.hypot(
        pointNormals[o],
        pointNormals[o + 1],
        pointNormals[o + 2],
      );
      if (len > 1e-10) {
        pointNormals[o] /= len;
        pointNormals[o + 1] /= len;
        pointNormals[o + 2] /= len;
      } else {
        pointNormals[o] = 0;
        pointNormals[o + 1] = 1;
        pointNormals[o + 2] = 0;
      }
    }

    // 各頂点に配布
    for (let v = 0; v < vertexCount; v++) {
      const pid = vertexPointIds[v] * 3;
      const o = srcOff + v * 3;
      normals[o] = pointNormals[pid];
      normals[o + 1] = pointNormals[pid + 1];
      normals[o + 2] = pointNormals[pid + 2];
    }
  }

  // デコード結果のサンプル表示
  console.log("[VAT] decoded pos frame0 vertex0:", positions[0], positions[1], positions[2]);
  console.log("[VAT] decoded nrm frame0 vertex0:", normals[0], normals[1], normals[2]);
  console.log("[VAT] animData ready:", { vertexCount, frameCount, indicesLen: indices.length, uvsLen: uvs.length });

  return { vertexCount, frameCount, indices, uvs, positions, normals, crumple, flat };
}
