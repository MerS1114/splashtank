// splash.cpp - native multithreaded baker for Splash Tank
// Build (Linux):   g++ -O3 -march=native -fopenmp splash.cpp -o splash
// Build (Mac):     brew install libomp, then
//                  clang++ -O3 -std=c++17 -Xpreprocessor -fopenmp -I$(brew --prefix libomp)/include -L$(brew --prefix libomp)/lib -lomp splash.cpp -o splash
// Build (Windows): cl /O2 /openmp /EHsc splash.cpp      (Developer Command Prompt for Visual Studio)
// Run:             splash scene.txt out.splc
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <map>
#include <random>
#include <string>
#include <vector>
#ifdef _OPENMP
#include <omp.h>
#endif
using namespace std;

struct Col { int t; float x, y, z, r, hx, hy, hz, c, s; };
struct Obj {
  string kind; int id = 0; float x = 0, y = 0, z = 0, yaw = 0, spin = 0, hx = 0.3f, hy = 0.3f, hz = 0.3f, r = 0.35f;
  float az = 0, el = -90, speed = 3, radius = 0.15f, spread = 0, density = 1; int on = 1, mode = 0;
  int start = 0; vector<float> rec;
};
struct Fill { float x0, x1, y0, y1, z0, z1; };
struct Ev { float t, x, y, z, r; };
struct Scene {
  float d = 0.05f, visc = 0.04f, g = 9.8f; int fps = 24, frames = 120, sub = 3, iters = 3; double maxn = 3000000;
  vector<Fill> fills; vector<Ev> events; vector<Obj> objs;
};

struct Sim {
  float d, h, h2, poly, spiky, W0, rho0, eps, c0, Gh, margin, rest = 0.1f;
  float X0 = -1.5f, X1 = 1.5f, Y0 = 0, Y1 = 2.6f, Z0 = -1.5f, Z1 = 1.5f;
  int nx, ny, nz, N = 0; size_t cap, alloc = 0; static const int MAXNB = 48;
  vector<float> P, V, Q, D, NV, BG, S, lam;
  vector<int> cid, sorted, nb, nc, cellStart, cellCount, cursor;
  mt19937 rng{12345};

  static double Gd(double h, double s) {
    double h2 = h * h, h4 = h2 * h2, h6 = h4 * h2, h8 = h4 * h4;
    double s2 = s * s, s3 = s2 * s, s5 = s3 * s2, s7 = s5 * s2, s9 = s7 * s2;
    return h8 * s - (4.0 / 3) * h6 * s3 + (6.0 / 5) * h4 * s5 - (4.0 / 7) * h2 * s7 + s9 / 9;
  }
  double Gfun(double s) const { return Gd(h, s); }

  Sim(float d_, size_t cap_) : d(d_), cap(cap_) {
    h = 2.2f * d; h2 = h * h;
    double hh = h;
    double polyD = 315.0 / (64.0 * M_PI * pow(hh, 9)), spikyD = -45.0 / (M_PI * pow(hh, 6));
    poly = (float)polyD; spiky = (float)spikyD; W0 = (float)(polyD * pow(hh * hh, 3));
    nx = (int)ceil((X1 - X0) / h) + 1; ny = (int)ceil((Y1 - Y0) / h) + 1; nz = (int)ceil((Z1 - Z0) / h) + 1;
    size_t cells = (size_t)nx * ny * nz; cellCount.assign(cells, 0); cellStart.assign(cells + 1, 0); cursor.assign(cells, 0);
    double r0 = 0, below = 0, sgRest = 0, dd = d;
    for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) for (int k = -3; k <= 3; k++) {
      double r2 = (i * i + j * j + k * k) * dd * dd;
      if (r2 < hh * hh) { double w = polyD * pow(hh * hh - r2, 3); r0 += w; if (k < 0) below += w; }
    }
    rho0 = (float)r0;
    for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) for (int k = -3; k <= 3; k++) {
      double r = sqrt((double)(i * i + j * j + k * k)) * dd;
      if (r > 1e-9 && r < hh) { double f = spikyD * (hh - r) * (hh - r) / r / r0 * r; sgRest += f * f; }
    }
    eps = (float)(0.64 * sgRest);
    double c0d = (1.0 / (dd * dd * dd)) * (M_PI / 4) * polyD, Ghd = Gd(hh, hh);
    double cont = c0d * (Ghd - Gd(hh, dd / 2));
    c0 = (float)(c0d * (below / cont) * 1.8); Gh = (float)Ghd; margin = 0.15f * d;
  }
  void grow(size_t n) {
    if (n <= alloc) return;
    size_t a = max<size_t>(n, alloc + alloc / 2 + 4096); if (a > cap) a = cap;
    P.resize(a * 3); V.resize(a * 3); Q.resize(a * 3); D.resize(a * 3); NV.resize(a * 3); BG.resize(a * 3);
    S.resize(a); lam.resize(a); cid.resize(a); sorted.resize(a); nc.resize(a); nb.resize(a * MAXNB); alloc = a;
  }
  bool add(float x, float y, float z, float vx, float vy, float vz) {
    if ((size_t)N >= cap) return false;
    grow(N + 1);
    int i3 = N * 3; P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z; V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
    S[N] = sqrtf(vx * vx + vy * vy + vz * vz); N++; return true;
  }
  float jit() { return (float)(rng() % 10000) / 10000.0f - 0.5f; }
  void fillBox(const Fill& f) {
    float j = 0.01f * d / 0.12f;
    for (float y = f.y0 + d / 2; y < f.y1; y += d) for (float x = f.x0 + d / 2; x < f.x1; x += d) for (float z = f.z0 + d / 2; z < f.z1; z += d)
      add(x + jit() * j, y + jit() * j, z + jit() * j, 0, 0, 0);
  }
  void fillSphere(float cx, float cy, float cz, float R, float vy) {
    float j = 0.01f * d / 0.12f;
    for (float y = -R; y <= R; y += d) for (float x = -R; x <= R; x += d) for (float z = -R; z <= R; z += d)
      if (x * x + y * y + z * z <= R * R) add(cx + x + jit() * j, cy + y + jit() * j, cz + z + jit() * j, 0, vy, 0);
  }
  void collide(const vector<Col>& cols) {
    float m = margin, x0 = X0 + m, x1 = X1 - m, y0 = Y0 + m, y1 = Y1 - m, z0 = Z0 + m, z1 = Z1 - m;
#pragma omp parallel for schedule(static)
    for (int i = 0; i < N; i++) {
      int i3 = i * 3; float x = Q[i3], y = Q[i3 + 1], z = Q[i3 + 2];
      for (const Col& c : cols) {
        if (c.t == 0) {
          float dx = x - c.x, dy = y - c.y, dz = z - c.z, R = c.r + m, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < R * R) { float dd = sqrtf(d2); if (dd < 1e-6f) y = c.y + R; else { float s = R / dd; x = c.x + dx * s; y = c.y + dy * s; z = c.z + dz * s; } }
        } else {
          float ox = x - c.x, oy = y - c.y, oz = z - c.z, lx = ox * c.c + oz * c.s, lz = -ox * c.s + oz * c.c;
          float ax = c.hx + m, ay = c.hy + m, az = c.hz + m, alx = fabsf(lx), aly = fabsf(oy), alz = fabsf(lz);
          if (alx < ax && aly < ay && alz < az) {
            float px = ax - alx, py = ay - aly, pz = az - alz;
            if (px <= py && px <= pz) lx = lx < 0 ? -ax : ax; else if (py <= pz) oy = oy < 0 ? -ay : ay; else lz = lz < 0 ? -az : az;
            x = c.x + lx * c.c - lz * c.s; z = c.z + lx * c.s + lz * c.c; y = c.y + oy;
          }
        }
      }
      Q[i3] = min(max(x, x0), x1); Q[i3 + 1] = min(max(y, y0), y1); Q[i3 + 2] = min(max(z, z0), z1);
    }
  }
  inline float bR(float p) const { return c0 * (Gh - (float)Gfun(p)); }
  inline float bD(float p) const { float t = h2 - p * p; t *= t; return -c0 * t * t; }
  void bnd(float x, float y, float z, const vector<Col>& cols, float& rho, float& gx, float& gy, float& gz) const {
    rho = gx = gy = gz = 0; float p;
    p = x - X0; if (p < h) { if (p < 0) p = 0; rho += bR(p); gx += bD(p); }
    p = X1 - x; if (p < h) { if (p < 0) p = 0; rho += bR(p); gx -= bD(p); }
    p = y - Y0; if (p < h) { if (p < 0) p = 0; rho += bR(p); gy += bD(p); }
    p = Y1 - y; if (p < h) { if (p < 0) p = 0; rho += bR(p); gy -= bD(p); }
    p = z - Z0; if (p < h) { if (p < 0) p = 0; rho += bR(p); gz += bD(p); }
    p = Z1 - z; if (p < h) { if (p < 0) p = 0; rho += bR(p); gz -= bD(p); }
    for (const Col& c : cols) {
      if (c.t == 0) {
        float dx = x - c.x, dy = y - c.y, dz = z - c.z, dist = sqrtf(dx * dx + dy * dy + dz * dz), phi = dist - c.r;
        if (phi >= h) continue; if (phi < 0) phi = 0;
        float dd = bD(phi); rho += bR(phi);
        if (dist > 1e-6f) { float s = dd / dist; gx += dx * s; gy += dy * s; gz += dz * s; } else gy += dd;
      } else {
        float ox = x - c.x, oy = y - c.y, oz = z - c.z, lx = ox * c.c + oz * c.s, lz = -ox * c.s + oz * c.c;
        float qx = fabsf(lx) - c.hx, qy = fabsf(oy) - c.hy, qz = fabsf(lz) - c.hz, nlx, nly, nlz, phi;
        if (qx < 0 && qy < 0 && qz < 0) {
          phi = 0; nlx = nly = nlz = 0;
          if (qx >= qy && qx >= qz) nlx = lx < 0 ? -1 : 1; else if (qy >= qz) nly = oy < 0 ? -1 : 1; else nlz = lz < 0 ? -1 : 1;
        } else {
          float mx = max(qx, 0.f), my = max(qy, 0.f), mz = max(qz, 0.f); phi = sqrtf(mx * mx + my * my + mz * mz);
          if (phi >= h) continue;
          float inv = phi > 1e-9f ? 1 / phi : 0; nlx = (lx < 0 ? -mx : mx) * inv; nly = (oy < 0 ? -my : my) * inv; nlz = (lz < 0 ? -mz : mz) * inv;
        }
        float dd = bD(phi); rho += bR(phi);
        gx += dd * (nlx * c.c - nlz * c.s); gy += dd * nly; gz += dd * (nlx * c.s + nlz * c.c);
      }
    }
  }
  void buildNeighbors() {
    float inv = 1 / h;
    fill(cellCount.begin(), cellCount.end(), 0);
    for (int i = 0; i < N; i++) {
      int i3 = i * 3, cx = (int)((Q[i3] - X0) * inv), cy = (int)((Q[i3 + 1] - Y0) * inv), cz = (int)((Q[i3 + 2] - Z0) * inv);
      cx = min(max(cx, 0), nx - 1); cy = min(max(cy, 0), ny - 1); cz = min(max(cz, 0), nz - 1);
      int c = cx + nx * (cy + ny * cz); cid[i] = c; cellCount[c]++;
    }
    size_t cells = (size_t)nx * ny * nz; cellStart[0] = 0;
    for (size_t c = 0; c < cells; c++) { cellStart[c + 1] = cellStart[c] + cellCount[c]; cursor[c] = cellStart[c]; }
    for (int i = 0; i < N; i++) sorted[cursor[cid[i]]++] = i;
#pragma omp parallel for schedule(static)
    for (int i = 0; i < N; i++) {
      int c = cid[i], cx = c % nx, t = c / nx, cy = t % ny, cz = t / ny, i3 = i * 3;
      float xi = Q[i3], yi = Q[i3 + 1], zi = Q[i3 + 2];
      int xa = max(cx - 1, 0), xb = min(cx + 1, nx - 1), ya = max(cy - 1, 0), yb = min(cy + 1, ny - 1), za = max(cz - 1, 0), zb = min(cz + 1, nz - 1);
      int base = i * MAXNB, n = 0;
      for (int z = za; z <= zb; z++) for (int y = ya; y <= yb; y++) {
        int row = nx * (y + ny * z);
        for (int s = cellStart[row + xa]; s < cellStart[row + xb + 1]; s++) {
          int j = sorted[s]; if (j == i) continue; int j3 = j * 3;
          float dx = xi - Q[j3], dy = yi - Q[j3 + 1], dz = zi - Q[j3 + 2];
          if (dx * dx + dy * dy + dz * dz < h2 && n < MAXNB) nb[base + n++] = j;
        }
      }
      nc[i] = n;
    }
  }
  void solve(const vector<Col>& cols) {
    float irho = 1 / rho0, maxD = 0.5f * d, maxD2 = maxD * maxD;
#pragma omp parallel for schedule(static)
    for (int i = 0; i < N; i++) {
      int i3 = i * 3; float xi = Q[i3], yi = Q[i3 + 1], zi = Q[i3 + 2], rho = W0, gx = 0, gy = 0, gz = 0, sg = 0;
      int base = i * MAXNB, cnt = nc[i];
      for (int k = 0; k < cnt; k++) {
        int j3 = nb[base + k] * 3; float dx = xi - Q[j3], dy = yi - Q[j3 + 1], dz = zi - Q[j3 + 2], r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue;
        float t = h2 - r2; rho += poly * t * t * t; float r = sqrtf(r2); if (r < 1e-7f) continue;
        float hr = h - r, f = spiky * hr * hr / r * irho, fx = f * dx, fy = f * dy, fz = f * dz;
        gx += fx; gy += fy; gz += fz; sg += fx * fx + fy * fy + fz * fz;
      }
      float br, bgx, bgy, bgz; bnd(xi, yi, zi, cols, br, bgx, bgy, bgz);
      rho += br; bgx *= irho; bgy *= irho; bgz *= irho; BG[i3] = bgx; BG[i3 + 1] = bgy; BG[i3 + 2] = bgz;
      gx += bgx; gy += bgy; gz += bgz; sg += bgx * bgx + bgy * bgy + bgz * bgz;
      float C = rho * irho - 1; lam[i] = C > 0 ? -C / (sg + gx * gx + gy * gy + gz * gz + eps) : 0;
    }
#pragma omp parallel for schedule(static)
    for (int i = 0; i < N; i++) {
      int i3 = i * 3; float xi = Q[i3], yi = Q[i3 + 1], zi = Q[i3 + 2], li = lam[i];
      float sx = li * BG[i3], sy = li * BG[i3 + 1], sz = li * BG[i3 + 2];
      int base = i * MAXNB, cnt = nc[i];
      for (int k = 0; k < cnt; k++) {
        int j = nb[base + k], j3 = j * 3; float s = li + lam[j]; if (s == 0) continue;
        float dx = xi - Q[j3], dy = yi - Q[j3 + 1], dz = zi - Q[j3 + 2], r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= h2) continue; float r = sqrtf(r2); if (r < 1e-7f) continue;
        float hr = h - r, f = spiky * hr * hr / r * irho * s; sx += f * dx; sy += f * dy; sz += f * dz;
      }
      float m2 = sx * sx + sy * sy + sz * sz; if (m2 > maxD2) { float k = maxD / sqrtf(m2); sx *= k; sy *= k; sz *= k; }
      D[i3] = sx; D[i3 + 1] = sy; D[i3 + 2] = sz;
    }
#pragma omp parallel for schedule(static)
    for (int i = 0; i < N * 3; i++) Q[i] += D[i];
  }
  void step(float dt, float g, int iters, float visc, const vector<Col>& cols) {
    if (!N) return;
#pragma omp parallel for schedule(static)
    for (int i = 0; i < N; i++) { int i3 = i * 3; V[i3 + 1] -= g * dt; for (int a = 0; a < 3; a++) Q[i3 + a] = P[i3 + a] + V[i3 + a] * dt; }
    collide(cols); buildNeighbors();
    for (int it = 0; it < iters; it++) { solve(cols); collide(cols); }
    float idt = 1 / dt, vmax = 12;
#pragma omp parallel for schedule(static)
    for (int i = 0; i < N; i++) {
      int i3 = i * 3; float vx = (Q[i3] - P[i3]) * idt, vy = (Q[i3 + 1] - P[i3 + 1]) * idt, vz = (Q[i3 + 2] - P[i3 + 2]) * idt;
      float gx = BG[i3], gy = BG[i3 + 1], gz = BG[i3 + 2], gm2 = gx * gx + gy * gy + gz * gz;
      if (gm2 > 1e-6f) {
        float gm = 1 / sqrtf(gm2), nx_ = -gx * gm, ny_ = -gy * gm, nz_ = -gz * gm, vo = V[i3] * nx_ + V[i3 + 1] * ny_ + V[i3 + 2] * nz_;
        if (vo < 0) { float vn = vx * nx_ + vy * ny_ + vz * nz_, lim = -vo * rest; if (vn > lim) { float k = vn - lim; vx -= k * nx_; vy -= k * ny_; vz -= k * nz_; } }
      }
      float s2 = vx * vx + vy * vy + vz * vz; if (s2 > vmax * vmax) { float k = vmax / sqrtf(s2); vx *= k; vy *= k; vz *= k; }
      V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
    }
    if (visc > 0) {
      float irho = 1 / rho0;
#pragma omp parallel for schedule(static)
      for (int i = 0; i < N; i++) {
        int i3 = i * 3; float xi = Q[i3], yi = Q[i3 + 1], zi = Q[i3 + 2], ax = 0, ay = 0, az = 0; int base = i * MAXNB, cnt = nc[i];
        for (int k = 0; k < cnt; k++) {
          int j3 = nb[base + k] * 3; float dx = xi - Q[j3], dy = yi - Q[j3 + 1], dz = zi - Q[j3 + 2], r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= h2) continue; float t = h2 - r2, w = poly * t * t * t * irho;
          ax += (V[j3] - V[i3]) * w; ay += (V[j3 + 1] - V[i3 + 1]) * w; az += (V[j3 + 2] - V[i3 + 2]) * w;
        }
        NV[i3] = V[i3] + visc * ax; NV[i3 + 1] = V[i3 + 1] + visc * ay; NV[i3 + 2] = V[i3 + 2] + visc * az;
      }
#pragma omp parallel for schedule(static)
      for (int i = 0; i < N * 3; i++) V[i] = NV[i];
    }
#pragma omp parallel for schedule(static)
    for (int i = 0; i < N; i++) { int i3 = i * 3; P[i3] = Q[i3]; P[i3 + 1] = Q[i3 + 1]; P[i3 + 2] = Q[i3 + 2]; S[i] = sqrtf(V[i3] * V[i3] + V[i3 + 1] * V[i3 + 1] + V[i3 + 2] * V[i3 + 2]); }
  }
};

struct EmState { double phase = 0, acc = 0; float radius = -1; vector<float> pts; };
struct Runner {
  Sim& sim; map<int, EmState> em; vector<Col> cols;
  explicit Runner(Sim& s) : sim(s) {}
  float rnd() { return (float)(sim.rng() % 100000) / 100000.0f; }
  void step(float dt, const vector<Obj>& st, const Scene& sc) {
    cols.clear();
    for (const Obj& o : st) {
      if (o.kind == "box") cols.push_back({1, o.x, o.y, o.z, 0, o.hx, o.hy, o.hz, cosf(o.yaw), sinf(o.yaw)});
      else if (o.kind == "sphere") cols.push_back({0, o.x, o.y, o.z, o.r, 0, 0, 0, 0, 0});
      else if (o.on) emit(o, dt);
    }
    sim.step(dt, sc.g, sc.iters, sc.visc, cols);
  }
  void emit(const Obj& o, float dt) {
    float d = sim.d; EmState& st = em[o.id];
    float az = o.az * (float)M_PI / 180, el = o.el * (float)M_PI / 180;
    float dx = cosf(el) * cosf(az), dy = sinf(el), dz = cosf(el) * sinf(az);
    float rx = 0, ry = 1, rz = 0; if (fabsf(dy) > 0.95f) { rx = 1; ry = 0; }
    float ux = dy * rz - dz * ry, uy = dz * rx - dx * rz, uz = dx * ry - dy * rx; float ul = sqrtf(ux * ux + uy * uy + uz * uz); if (ul < 1e-9f) ul = 1; ux /= ul; uy /= ul; uz /= ul;
    float wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
    float sp = o.spread, v = o.speed, veff = max(v, 0.3f);
    auto jt = [&]() { return sp > 0 ? (rnd() - 0.5f) * 2 * sp : 0.f; };
    if (o.mode == 1) {
      st.acc += M_PI * o.radius * o.radius * veff / ((double)d * d * d) * o.density * dt;
      int n = (int)floor(st.acc); st.acc -= n;
      for (int k = 0; k < n; k++) {
        float a = rnd() * 6.2831853f, rr = o.radius * sqrtf(rnd()), ca = cosf(a) * rr, sa = sinf(a) * rr, adv = rnd() * veff * dt;
        if (!sim.add(o.x + ux * ca + wx * sa + dx * adv, o.y + uy * ca + wy * sa + dy * adv, o.z + uz * ca + wz * sa + dz * adv, dx * v + jt(), dy * v + jt(), dz * v + jt())) break;
      }
      return;
    }
    if (st.radius != o.radius) {
      st.pts.clear(); int R = (int)ceil(o.radius / d) + 1;
      for (int i = -R; i <= R; i++) for (int j = -R; j <= R; j++) { float a = (i + 0.5f) * d, c = (j + 0.5f) * d; if (a * a + c * c <= o.radius * o.radius) { st.pts.push_back(a); st.pts.push_back(c); } }
      if (st.pts.empty()) { st.pts.push_back(0); st.pts.push_back(0); }
      st.radius = o.radius;
    }
    st.phase += veff * dt;
    for (int guard = 0; st.phase >= d && guard < 8; guard++) {
      st.phase -= d; float adv = (float)st.phase;
      for (size_t k = 0; k < st.pts.size(); k += 2) {
        float a = st.pts[k], c = st.pts[k + 1];
        if (!sim.add(o.x + ux * a + wx * c + dx * adv, o.y + uy * a + wy * c + dy * adv, o.z + uz * a + wz * c + dz * adv, dx * v + jt(), dy * v + jt(), dz * v + jt())) return;
      }
    }
  }
};

static Obj sampleObj(const Obj& o, float t) {
  Obj s = o;
  if (o.rec.size() >= 4) {
    int n = (int)(o.rec.size() / 4); float k = t * 60 - o.start; k = min(max(k, 0.f), (float)(n - 1));
    int i0 = (int)floorf(k), i1 = min(i0 + 1, n - 1); float w = k - i0; const float* a = o.rec.data();
    s.x = a[i0 * 4] + (a[i1 * 4] - a[i0 * 4]) * w; s.y = a[i0 * 4 + 1] + (a[i1 * 4 + 1] - a[i0 * 4 + 1]) * w;
    s.z = a[i0 * 4 + 2] + (a[i1 * 4 + 2] - a[i0 * 4 + 2]) * w; s.yaw = a[i0 * 4 + 3] + (a[i1 * 4 + 3] - a[i0 * 4 + 3]) * w;
  } else s.yaw = o.yaw + o.spin * t;
  return s;
}

static bool loadScene(const char* path, Scene& sc) {
  ifstream f(path); if (!f) return false; string w;
  while (f >> w) {
    if (w == "splash-scene") { int v; f >> v; }
    else if (w == "d") f >> sc.d; else if (w == "fps") f >> sc.fps; else if (w == "frames") f >> sc.frames;
    else if (w == "substeps") f >> sc.sub; else if (w == "iters") f >> sc.iters; else if (w == "visc") f >> sc.visc;
    else if (w == "gravity") f >> sc.g; else if (w == "maxn") f >> sc.maxn;
    else if (w == "fill") { string k; f >> k; Fill b{}; f >> b.x0 >> b.x1 >> b.y0 >> b.y1 >> b.z0 >> b.z1; sc.fills.push_back(b); }
    else if (w == "event") { Ev e{}; f >> e.t >> e.x >> e.y >> e.z >> e.r; sc.events.push_back(e); }
    else if (w == "obj") {
      Obj o; f >> o.kind >> o.id >> o.x >> o.y >> o.z >> o.yaw >> o.spin;
      if (o.kind == "box") f >> o.hx >> o.hy >> o.hz; else if (o.kind == "sphere") f >> o.r;
      else f >> o.az >> o.el >> o.speed >> o.radius >> o.on >> o.mode >> o.spread >> o.density;
      sc.objs.push_back(o);
    } else if (w == "track") {
      int id, start, n; f >> id >> start >> n;
      for (Obj& o : sc.objs) if (o.id == id) { o.start = start; o.rec.resize((size_t)n * 4); for (size_t i = 0; i < (size_t)n * 4; i++) f >> o.rec[i]; }
      if (n == 0) continue;
    }
  }
  sort(sc.events.begin(), sc.events.end(), [](const Ev& a, const Ev& b) { return a.t < b.t; });
  return true;
}

template <class T> static void put(FILE* f, T v) { fwrite(&v, sizeof(T), 1, f); }

int main(int argc, char** argv) {
  if (argc < 3) { printf("usage: splash scene.txt out.splc\n"); return 1; }
  Scene sc; if (!loadScene(argv[1], sc)) { printf("cannot read %s\n", argv[1]); return 1; }
  Sim sim(sc.d, (size_t)sc.maxn); Runner run(sim);
  for (const Fill& f : sc.fills) sim.fillBox(f);
  FILE* out = fopen(argv[2], "wb"); if (!out) { printf("cannot write %s\n", argv[2]); return 1; }
  int F = sc.frames, nobj = (int)sc.objs.size();
  fwrite("SPLC", 1, 4, out); put<uint32_t>(out, 1); put<float>(out, sc.d); put<uint32_t>(out, sc.fps); put<uint32_t>(out, F + 1); put<uint32_t>(out, nobj);
  for (const Obj& o : sc.objs) put<uint32_t>(out, (uint32_t)o.id);
  float dt = 1.0f / sc.fps / sc.sub; size_t ei = 0;
  auto sampleAll = [&](float t) { vector<Obj> v; for (const Obj& o : sc.objs) v.push_back(sampleObj(o, t)); return v; };
  auto writeFrame = [&](float t) {
    int n = sim.N; put<uint32_t>(out, (uint32_t)n);
    for (const Obj& o : sampleAll(t)) { put<float>(out, o.x); put<float>(out, o.y); put<float>(out, o.z); put<float>(out, o.yaw); }
    vector<uint16_t> pos((size_t)n * 3); vector<uint8_t> spd(n);
    float kx = 65535.f / (sim.X1 - sim.X0), ky = 65535.f / (sim.Y1 - sim.Y0), kz = 65535.f / (sim.Z1 - sim.Z0);
#pragma omp parallel for schedule(static)
    for (int i = 0; i < n; i++) {
      int i3 = i * 3;
      pos[i3] = (uint16_t)min(max(lroundf((sim.P[i3] - sim.X0) * kx), 0L), 65535L);
      pos[i3 + 1] = (uint16_t)min(max(lroundf((sim.P[i3 + 1] - sim.Y0) * ky), 0L), 65535L);
      pos[i3 + 2] = (uint16_t)min(max(lroundf((sim.P[i3 + 2] - sim.Z0) * kz), 0L), 65535L);
      float s = sim.S[i] * 16; spd[i] = (uint8_t)(s > 255 ? 255 : s);
    }
    fwrite(pos.data(), 2, pos.size(), out); fwrite(spd.data(), 1, spd.size(), out);
  };
  writeFrame(0);
  auto t0 = chrono::steady_clock::now();
#ifdef _OPENMP
  printf("threads: %d\n", omp_get_max_threads());
#endif
  for (int f = 1; f <= F; f++) {
    for (int s = 0; s < sc.sub; s++) {
      float t = ((f - 1) * sc.sub + s + 1) * dt;
      while (ei < sc.events.size() && sc.events[ei].t <= t) { const Ev& e = sc.events[ei++]; sim.fillSphere(e.x, e.y, e.z, e.r, -1); }
      run.step(dt, sampleAll(t), sc);
    }
    writeFrame((float)f / sc.fps);
    double el = chrono::duration<double>(chrono::steady_clock::now() - t0).count();
    printf("frame %d/%d  %d points  %.1fs elapsed, about %.0fs left\n", f, F, sim.N, el, el / f * (F - f)); fflush(stdout);
  }
  fclose(out); printf("done: %s\n", argv[2]); return 0;
}
