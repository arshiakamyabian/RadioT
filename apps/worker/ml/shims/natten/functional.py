"""Pure-PyTorch stand-in for the four NATTEN ops that All-In-One uses.

NATTEN's compiled kernels don't build against current PyTorch on macOS. All-In-One only calls the
1D/2D "query-key with relative position bias" and "attention-value" ops, which are small enough to
express with gathers. Neighbourhoods follow NATTEN's rules exactly: windows near an edge are
shifted inwards (not padded), dilation splits the axis into interleaved groups, and the bias index
follows the same shift. See `test_natten_shim.py` for the brute-force check.
"""

from functools import lru_cache

import torch


def _window_start(index: int, length: int, kernel: int, nb: int, dilation: int) -> int:
    if dilation <= 1:
        start = max(index - nb, 0)
        if index + nb >= length:
            start += length - index - nb - 1
        return start
    ni = index - nb * dilation
    if ni < 0:
        return index % dilation
    if index + nb * dilation >= length:
        imodd = index % dilation
        a = (length // dilation) * dilation
        b = length - a
        if imodd < b:
            return length - b + imodd - 2 * nb * dilation
        return a + imodd - kernel * dilation
    return ni


def _bias_start(index: int, length: int, kernel: int, nb: int, dilation: int) -> int:
    if dilation <= 1:
        start = nb
        if index < nb:
            start += nb - index
        if index + nb >= length:
            start += length - index - 1 - nb
        return start
    if index - nb * dilation < 0:
        return kernel - 1 - (index // dilation)
    if index + nb * dilation >= length:
        return (length - index - 1) // dilation
    return nb


@lru_cache(maxsize=64)
def _indices(length: int, kernel: int, dilation: int, device: str):
    nb = kernel // 2
    keys = torch.empty(length, kernel, dtype=torch.long)
    bias = torch.empty(length, kernel, dtype=torch.long)
    for i in range(length):
        s = _window_start(i, length, kernel, nb, dilation)
        p = _bias_start(i, length, kernel, nb, dilation)
        for k in range(kernel):
            keys[i, k] = s + k * dilation
            bias[i, k] = p + k
    return keys.to(device), bias.to(device)


def natten1dqkrpb(query, key, rpb, kernel_size, dilation):
    # query/key: (B, heads, L, D); rpb: (heads, 2K-1) -> (B, heads, L, K)
    L = query.shape[2]
    keys, bias = _indices(L, kernel_size, dilation, str(query.device))
    k = key[:, :, keys]  # (B, H, L, K, D)
    attn = (query.unsqueeze(3) * k).sum(-1)
    if rpb is not None:
        attn = attn + rpb[:, bias].unsqueeze(0)
    return attn


def natten1dav(attn, value, kernel_size, dilation):
    L = value.shape[2]
    keys, _ = _indices(L, kernel_size, dilation, str(value.device))
    v = value[:, :, keys]  # (B, H, L, K, D)
    return (attn.unsqueeze(-1) * v).sum(3)


def natten2dqkrpb(query, key, rpb, kernel_size, dilation):
    # query/key: (B, heads, X, Y, D); rpb: (heads, 2K-1, 2K-1) -> (B, heads, X, Y, K*K)
    B, H, X, Y, D = query.shape
    kx, bx = _indices(X, kernel_size, dilation, str(query.device))
    ky, by = _indices(Y, kernel_size, dilation, str(query.device))
    K = kernel_size
    k = key[:, :, kx]  # (B, H, X, K, Y, D)
    k = k[:, :, :, :, ky]  # (B, H, X, K, Y, K, D)
    k = k.permute(0, 1, 2, 4, 3, 5, 6)  # (B, H, X, Y, Kx, Ky, D)
    attn = (query.unsqueeze(4).unsqueeze(4) * k).sum(-1)  # (B, H, X, Y, Kx, Ky)
    if rpb is not None:
        b = rpb[:, bx[:, :, None, None], by[None, None, :, :]]  # (H, X, Kx, Y, Ky)
        attn = attn + b.permute(0, 1, 3, 2, 4).unsqueeze(0)
    return attn.reshape(B, H, X, Y, K * K)


def natten2dav(attn, value, kernel_size, dilation):
    B, H, X, Y, D = value.shape
    K = kernel_size
    kx, _ = _indices(X, kernel_size, dilation, str(value.device))
    ky, _ = _indices(Y, kernel_size, dilation, str(value.device))
    v = value[:, :, kx][:, :, :, :, ky].permute(0, 1, 2, 4, 3, 5, 6)  # (B, H, X, Y, Kx, Ky, D)
    a = attn.reshape(B, H, X, Y, K, K, 1)
    return (a * v).sum((4, 5))
