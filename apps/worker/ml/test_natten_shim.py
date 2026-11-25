"""Checks the NATTEN shim against a direct definition of dilated neighbourhood attention.

Run: .venv/bin/python test_natten_shim.py
"""

import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).parent / "shims"))
from natten.functional import natten1dav, natten1dqkrpb, natten2dav, natten2dqkrpb  # noqa: E402


def neighbours(i: int, length: int, kernel: int, dilation: int):
    """Positions i attends to and their relative offsets: the K nearest of its dilation group,
    window shifted inwards at the edges."""
    g = i % dilation
    group_len = len(range(g, length, dilation))
    ii = i // dilation
    start = min(max(ii - kernel // 2, 0), group_len - kernel)
    pos = [g + (start + k) * dilation for k in range(kernel)]
    rel = [(start + k) - ii + kernel - 1 for k in range(kernel)]
    return pos, rel


def ref1d(q, k, v, rpb, K, d):
    B, H, L, D = q.shape
    out = torch.zeros_like(q)
    for i in range(L):
        pos, rel = neighbours(i, L, K, d)
        s = torch.einsum("bhd,bhkd->bhk", q[:, :, i], k[:, :, pos]) + rpb[:, rel]
        out[:, :, i] = torch.einsum("bhk,bhkd->bhd", s.softmax(-1), v[:, :, pos])
    return out


def ref2d(q, k, v, rpb, K, d):
    B, H, X, Y, D = q.shape
    out = torch.zeros_like(q)
    for x in range(X):
        px, rx = neighbours(x, X, K, d)
        for y in range(Y):
            py, ry = neighbours(y, Y, K, d)
            kk = k[:, :, px][:, :, :, py].reshape(B, H, K * K, D)
            vv = v[:, :, px][:, :, :, py].reshape(B, H, K * K, D)
            bias = rpb[:, rx][:, :, ry].reshape(H, K * K)
            s = torch.einsum("bhd,bhkd->bhk", q[:, :, x, y], kk) + bias
            out[:, :, x, y] = torch.einsum("bhk,bhkd->bhd", s.softmax(-1), vv)
    return out


def main():
    torch.manual_seed(0)
    worst = 0.0
    for L, K, d in [(37, 5, 1), (37, 5, 2), (40, 5, 3), (64, 5, 6), (23, 3, 7), (16, 5, 3)]:
        q, k, v = (torch.randn(2, 3, L, 8) for _ in range(3))
        rpb = torch.randn(3, 2 * K - 1)
        got = natten1dav(natten1dqkrpb(q, k, rpb, K, d).softmax(-1), v, K, d)
        err = (got - ref1d(q, k, v, rpb, K, d)).abs().max().item()
        worst = max(worst, err)
        print(f"1d L={L} K={K} d={d}: max error {err:.2e}")
    for X, Y, K, d in [(11, 13, 5, 1), (12, 17, 3, 2), (15, 15, 5, 3)]:
        q, k, v = (torch.randn(1, 2, X, Y, 4) for _ in range(3))
        rpb = torch.randn(2, 2 * K - 1, 2 * K - 1)
        got = natten2dav(natten2dqkrpb(q, k, rpb, K, d).softmax(-1), v, K, d)
        err = (got - ref2d(q, k, v, rpb, K, d)).abs().max().item()
        worst = max(worst, err)
        print(f"2d {X}x{Y} K={K} d={d}: max error {err:.2e}")
    assert worst < 1e-5, worst
    print("ok")


if __name__ == "__main__":
    main()
