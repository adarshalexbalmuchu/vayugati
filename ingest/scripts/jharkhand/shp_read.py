import struct, sys, json

def read_dbf(path):
    d = open(path, 'rb').read()
    n, hlen, rlen = struct.unpack_from('<IHH', d, 4)
    fields, off = [], 32
    while d[off] != 0x0D:
        name = d[off:off+11].split(b'\0')[0].decode(); ftype = chr(d[off+11]); flen = d[off+16]
        fields.append((name, ftype, flen)); off += 32
    rows = []
    for i in range(n):
        rec = d[hlen + i*rlen: hlen + (i+1)*rlen]
        p = 1; row = {}
        for name, t, l in fields:
            row[name] = rec[p:p+l].decode('latin1').strip(); p += l
        rows.append(row)
    return rows

def read_shp(path):
    d = open(path, 'rb').read()
    pos = 100; out = []
    while pos < len(d):
        _, clen = struct.unpack_from('>ii', d, pos); pos += 8
        body = d[pos:pos+clen*2]; pos += clen*2
        st = struct.unpack_from('<i', body, 0)[0]
        if st == 0: out.append(None); continue
        nparts, npts = struct.unpack_from('<ii', body, 36)
        parts = list(struct.unpack_from(f'<{nparts}i', body, 44))
        pts = struct.unpack_from(f'<{npts*2}d', body, 44 + 4*nparts)
        pts = [(pts[2*i], pts[2*i+1]) for i in range(npts)]
        parts.append(npts)
        out.append([pts[parts[i]:parts[i+1]] for i in range(nparts)])
    return out
