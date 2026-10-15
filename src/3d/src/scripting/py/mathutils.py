"""Vector math for scripts (Vector, Matrix, Euler, Quaternion, Color) and the geometry,
kdtree, bvhtree and noise submodules.

An independent pure-Python implementation whose public names follow the documented
`mathutils` module so existing scripts keep working. Matrices are row-major and act on
column vectors (``M @ v``). Euler order 'XYZ' applies the X rotation first.
"""

import math

__all__ = ("Vector", "Matrix", "Euler", "Quaternion", "Color", "geometry", "kdtree", "bvhtree", "noise")

_EPS = 1e-12


def _seq(v):
    if isinstance(v, (Vector, Euler, Quaternion, Color)):
        return [v[i] for i in range(len(v))]
    return [float(x) for x in v]


def _fmt(x):
    s = repr(round(float(x), 4))
    return s


class _Base:
    """Component storage shared by all vector-like types; subclasses may override the
    three storage hooks to read/write through to document data (bound vectors)."""

    __slots__ = ("_d",)

    def __init__(self, seq=(0.0, 0.0, 0.0)):
        object.__setattr__(self, "_d", [float(x) for x in _seq(seq)])

    # storage hooks
    def _len(self):
        return len(self._d)

    def _getc(self, i):
        return self._d[i]

    def _setc(self, i, v):
        self._d[i] = float(v)

    # sequence protocol
    def __len__(self):
        return self._len()

    def __getitem__(self, i):
        n = self._len()
        if isinstance(i, slice):
            return tuple(self._getc(k) for k in range(*i.indices(n)))
        if i < 0:
            i += n
        if not 0 <= i < n:
            raise IndexError("index out of range")
        return self._getc(i)

    def __setitem__(self, i, v):
        n = self._len()
        if isinstance(i, slice):
            idx = list(range(*i.indices(n)))
            vals = list(v)
            if len(vals) != len(idx):
                raise ValueError("slice assignment: size mismatch")
            for k, x in zip(idx, vals):
                self._setc(k, x)
            return
        if i < 0:
            i += n
        if not 0 <= i < n:
            raise IndexError("index out of range")
        self._setc(i, float(v))

    def __iter__(self):
        return iter([self._getc(i) for i in range(self._len())])

    def _list(self):
        return [self._getc(i) for i in range(self._len())]

    def _assign(self, seq):
        vals = _seq(seq)
        for i in range(self._len()):
            self._setc(i, vals[i] if i < len(vals) else 0.0)
        return self

    def to_tuple(self, precision=-1):
        if precision < 0:
            return tuple(self._list())
        return tuple(round(x, precision) for x in self._list())

    def to_list(self):
        return self._list()

    def copy(self):
        return type(self).__mro__[self._plain_index()](self._list())

    def _plain_index(self):
        # first non-bound class in the MRO (bound subclasses are named _Bound*)
        for k, c in enumerate(type(self).__mro__):
            if not c.__name__.startswith("_Bound"):
                return k
        return 0

    def __copy__(self):
        return self.copy()

    def __deepcopy__(self, memo):
        return self.copy()

    def freeze(self):
        return self

    @property
    def is_frozen(self):
        return False

    @property
    def is_wrapped(self):
        return False

    def __eq__(self, other):
        try:
            o = _seq(other)
        except TypeError:
            return NotImplemented
        return len(o) == self._len() and all(a == b for a, b in zip(self._list(), o))

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    __hash__ = None


def _swizzle(name):
    if 2 <= len(name) <= 4 and all(c in "xyzw" for c in name):
        return ["xyzw".index(c) for c in name]
    return None


class Vector(_Base):
    __slots__ = ()

    def __init__(self, seq=(0.0, 0.0, 0.0)):
        _Base.__init__(self, seq)

    # components
    @property
    def x(self):
        return self[0]

    @x.setter
    def x(self, v):
        self[0] = v

    @property
    def y(self):
        return self[1]

    @y.setter
    def y(self, v):
        self[1] = v

    @property
    def z(self):
        return self[2]

    @z.setter
    def z(self, v):
        self[2] = v

    @property
    def w(self):
        return self[3]

    @w.setter
    def w(self, v):
        self[3] = v

    def __getattr__(self, name):
        idx = _swizzle(name)
        if idx is None or max(idx) >= self._len():
            raise AttributeError("Vector has no attribute '%s'" % name)
        return Vector([self._getc(i) for i in idx])

    def __setattr__(self, name, value):
        idx = _swizzle(name)
        if idx is not None and len(name) > 1:
            vals = _seq(value)
            for i, v in zip(idx, vals):
                self[i] = v
            return
        object.__setattr__(self, name, value)

    # metrics
    @property
    def length(self):
        return math.sqrt(sum(x * x for x in self._list()))

    @length.setter
    def length(self, value):
        n = self.length
        if n > _EPS:
            self._assign([x * value / n for x in self._list()])

    @property
    def length_squared(self):
        return sum(x * x for x in self._list())

    @property
    def magnitude(self):
        return self.length

    def normalized(self):
        n = self.length
        if n < _EPS:
            return Vector([0.0] * self._len())
        return Vector([x / n for x in self._list()])

    def normalize(self):
        self._assign(self.normalized())
        return None

    def zero(self):
        self._assign([0.0] * self._len())

    def negate(self):
        self._assign([-x for x in self._list()])

    def dot(self, other):
        return sum(a * b for a, b in zip(self._list(), _seq(other)))

    def cross(self, other):
        a, b = self._list(), _seq(other)
        if len(a) == 2:
            return a[0] * b[1] - a[1] * b[0]
        return Vector((a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]))

    def angle(self, other, fallback=None):
        o = Vector(other)
        d = self.length * o.length
        if d < _EPS:
            if fallback is not None:
                return fallback
            raise ValueError("Vector.angle(other): zero length vectors have no valid angle")
        return math.acos(max(-1.0, min(1.0, self.dot(o) / d)))

    def angle_signed(self, other, fallback=None):
        o = _seq(other)
        if self._len() != 2 or len(o) != 2:
            raise ValueError("Vector.angle_signed(other): only 2D vectors are supported")
        a = self._list()
        if math.hypot(a[0], a[1]) < _EPS or math.hypot(o[0], o[1]) < _EPS:
            if fallback is not None:
                return fallback
            raise ValueError("Vector.angle_signed(other): zero length vectors have no valid angle")
        return -math.atan2(a[0] * o[1] - a[1] * o[0], a[0] * o[0] + a[1] * o[1])

    def lerp(self, other, factor):
        return Vector([a + (b - a) * factor for a, b in zip(self._list(), _seq(other))])

    def slerp(self, other, factor, fallback=None):
        """Spherical interpolation of the directions (the result is unit length)."""
        a, b = self.normalized(), Vector(other).normalized()
        d = max(-1.0, min(1.0, a.dot(b)))
        if self.length < _EPS or Vector(other).length < _EPS or d < -1.0 + 1e-6:
            if fallback is not None:
                return fallback
            raise ValueError("Vector.slerp(): zero length vectors or opposite vectors have no unique interpolation")
        if d > 1.0 - 1e-9:
            return a.lerp(b, factor).normalized()
        th = math.acos(d)
        s = math.sin(th)
        return a * (math.sin((1 - factor) * th) / s) + b * (math.sin(factor * th) / s)

    def project(self, other):
        o = Vector(other)
        d = o.length_squared
        return o * (self.dot(o) / d) if d > _EPS else o * 0.0

    def reflect(self, mirror):
        n = Vector(mirror).normalized()
        return self - n * (2.0 * self.dot(n))

    def rotate(self, other):
        if isinstance(other, (Euler, Quaternion)):
            m = other.to_matrix()
        else:
            m = other.to_3x3()
        r = m @ self.to_3d()
        for i in range(min(3, self._len())):
            self[i] = r[i]

    def rotation_difference(self, other):
        a, b = self.normalized(), Vector(other).normalized()
        axis = a.cross(b)
        d = max(-1.0, min(1.0, a.dot(b)))
        if axis.length < 1e-9:
            if d > 0:
                return Quaternion()
            return Quaternion(a.orthogonal().normalized(), math.pi)
        return Quaternion(axis.normalized(), math.acos(d))

    def to_2d(self):
        return Vector(self._list()[:2])

    def to_3d(self):
        v = self._list() + [0.0, 0.0, 0.0]
        return Vector(v[:3])

    def to_4d(self):
        v = self._list()
        v = (v + [0.0, 0.0, 0.0])[:3] + [v[3] if len(v) > 3 else 1.0]
        return Vector(v)

    def resized(self, size):
        v = self._list() + [0.0] * size
        return Vector(v[:size])

    def resize(self, size):
        if type(self) is not Vector:
            raise TypeError("Vector.resize(): cannot resize a vector that wraps document data")
        v = self._list() + [0.0] * size
        object.__setattr__(self, "_d", v[:size])

    def resize_2d(self):
        self.resize(2)

    def resize_3d(self):
        self.resize(3)

    def resize_4d(self):
        w = self[3] if self._len() > 3 else 1.0
        self.resize(4)
        self[3] = w

    def to_track_quat(self, track="Z", up="Y"):
        """Rotation pointing the local `track` axis along this vector, with the local `up`
        axis turned as close as possible to world +Z."""
        axes = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1), "-X": (-1, 0, 0), "-Y": (0, -1, 0), "-Z": (0, 0, -1)}
        if track not in axes:
            raise ValueError("Vector.to_track_quat(): invalid track axis '%s'" % track)
        if up not in ("X", "Y", "Z"):
            raise ValueError("Vector.to_track_quat(): invalid up axis '%s'" % up)
        if track.lstrip("-") == up:
            raise ValueError("Vector.to_track_quat(): track and up axis cannot be the same")
        t, u = Vector(axes[track]), Vector(axes[up])
        v = self.to_3d()
        n = v.length
        if n < 1e-6:
            return Quaternion()
        d = v / n
        target = Vector((0.0, 0.0, 1.0)) - d * d.z
        if target.length < 1e-6:
            if t.z == 0:
                target = t * (-1.0 if d.z > 0 else 1.0)
            elif t.z * d.z > 0:
                target = u * (-1.0 if d.z > 0 else 1.0)
            else:
                target = Vector((0.0, -1.0, 0.0))
        target = target.normalized()
        third = d.cross(target)
        w = t.cross(u)
        rows = [[d[i] * t[j] + target[i] * u[j] + third[i] * w[j] for j in range(3)] for i in range(3)]
        return Matrix(rows).to_quaternion()

    def orthogonal(self):
        """A vector perpendicular to this one (not normalized)."""
        a = self._list()
        if len(a) == 2:
            return Vector((-a[1], a[0]))
        ab = [abs(x) for x in a]
        k = 0 if ab[0] >= ab[1] and ab[0] >= ab[2] else (1 if ab[1] >= ab[2] else 2)
        i, j = (k + 1) % 3, (k + 2) % 3
        out = [0.0, 0.0, 0.0]
        out[k] = -a[i] - a[j]
        out[i] = a[k]
        out[j] = a[k]
        return Vector(out)

    # arithmetic
    def __add__(self, o):
        return Vector([a + b for a, b in zip(self._list(), _seq(o))])

    __radd__ = __add__

    def __sub__(self, o):
        return Vector([a - b for a, b in zip(self._list(), _seq(o))])

    def __rsub__(self, o):
        return Vector([b - a for a, b in zip(self._list(), _seq(o))])

    def __mul__(self, o):
        if isinstance(o, (int, float)):
            return Vector([a * o for a in self._list()])
        if isinstance(o, (Matrix, Quaternion)):
            return NotImplemented
        return Vector([a * b for a, b in zip(self._list(), _seq(o))])

    def __rmul__(self, o):
        return self.__mul__(o)

    def __truediv__(self, o):
        if o == 0:
            raise ZeroDivisionError("Vector division by zero")
        return Vector([a / o for a in self._list()])

    def __matmul__(self, o):
        if isinstance(o, Matrix):
            # row vector times matrix
            v = self._list()
            rows = o._rows
            if len(v) == 3 and len(rows) == 4:
                v = v + [1.0]
            if len(v) != len(rows):
                raise ValueError("vector @ matrix: vector size %d does not match matrix rows %d" % (len(v), len(rows)))
            out = [sum(v[i] * rows[i][j] for i in range(len(v))) for j in range(len(rows[0]))]
            return Vector(out[:3] if self._len() == 3 and len(out) == 4 else out)
        return self.dot(o)

    def __neg__(self):
        return Vector([-a for a in self._list()])

    def __pos__(self):
        return Vector(self._list())

    def __abs__(self):
        return Vector([abs(a) for a in self._list()])

    def __iadd__(self, o):
        self._assign(self + o)
        return self

    def __isub__(self, o):
        self._assign(self - o)
        return self

    def __imul__(self, o):
        self._assign(self * o)
        return self

    def __itruediv__(self, o):
        self._assign(self / o)
        return self

    def __lt__(self, o):
        return self.length < Vector(o).length

    def __gt__(self, o):
        return self.length > Vector(o).length

    def __repr__(self):
        return "Vector((%s))" % ", ".join(_fmt(x) for x in self._list())

    def __str__(self):
        return "<Vector (%s)>" % ", ".join("%.4f" % x for x in self._list())

    @classmethod
    def Fill(cls, size, fill=0.0):
        return cls([fill] * size)

    @classmethod
    def Range(cls, start, stop=None, step=1):
        if stop is None:
            start, stop = 0, start
        return cls(list(range(start, stop, step)))

    @classmethod
    def Linspace(cls, start, stop, size):
        if size == 1:
            return cls([start])
        return cls([start + (stop - start) * i / (size - 1) for i in range(size)])

    @classmethod
    def Repeat(cls, vector, size):
        v = _seq(vector)
        return cls([v[i % len(v)] for i in range(size)])


class Color(_Base):
    __slots__ = ()

    def __init__(self, rgb=(0.0, 0.0, 0.0)):
        _Base.__init__(self, rgb)

    r = property(lambda s: s[0], lambda s, v: s.__setitem__(0, v))
    g = property(lambda s: s[1], lambda s, v: s.__setitem__(1, v))
    b = property(lambda s: s[2], lambda s, v: s.__setitem__(2, v))

    @property
    def a(self):
        return self[3] if len(self) > 3 else 1.0

    @a.setter
    def a(self, v):
        if len(self) > 3:
            self[3] = v

    @property
    def h(self):
        return self._hsv()[0]

    @h.setter
    def h(self, x):
        _, s, v = self._hsv()
        self.hsv = (x, s, v)

    @property
    def s(self):
        return self._hsv()[1]

    @s.setter
    def s(self, x):
        h, _, v = self._hsv()
        self.hsv = (h, x, v)

    @property
    def v(self):
        return self._hsv()[2]

    @v.setter
    def v(self, x):
        h, s, _ = self._hsv()
        self.hsv = (h, s, x)

    def _mapped(self, f):
        return Color([f(c) if i < 3 else c for i, c in enumerate(self._list())])

    def _transformed(self, m):
        a = self._list()
        return Color([sum(m[i][k] * a[k] for k in range(3)) for i in range(3)] + a[3:])

    def from_scene_linear_to_srgb(self):
        return self._mapped(lambda c: 0.0 if c < 0 else (c * 12.92 if c < 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055))

    def from_srgb_to_scene_linear(self):
        return self._mapped(lambda c: 0.0 if c < 0 else (c / 12.92 if c < 0.04045 else ((c + 0.055) / 1.055) ** 2.4))

    def from_scene_linear_to_xyz_d65(self):
        return self._transformed(_TO_XYZ)

    def from_xyz_d65_to_scene_linear(self):
        return self._transformed(_inv3(_TO_XYZ))

    def from_scene_linear_to_aces(self):
        return self._transformed(_TO_ACES)

    def from_aces_to_scene_linear(self):
        return self._transformed(_inv3(_TO_ACES))

    def from_scene_linear_to_acescg(self):
        return self._transformed(_TO_ACESCG)

    def from_acescg_to_scene_linear(self):
        return self._transformed(_inv3(_TO_ACESCG))

    def from_scene_linear_to_rec2020_linear(self):
        return self._transformed(_TO_REC2020)

    def from_rec2020_linear_to_scene_linear(self):
        return self._transformed(_inv3(_TO_REC2020))

    def from_scene_linear_to_rec709_linear(self):
        return Color(self._list())

    def from_rec709_linear_to_scene_linear(self):
        return Color(self._list())

    @property
    def hsv(self):
        return self._hsv()

    @hsv.setter
    def hsv(self, hsv):
        h, s, v = hsv
        h = (h % 1.0) * 6.0
        i = int(h) % 6
        f = h - int(h)
        p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
        rgb = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]
        for k in range(3):
            self[k] = rgb[k]

    def _hsv(self):
        r, g, b = self[0], self[1], self[2]
        mx, mn = max(r, g, b), min(r, g, b)
        d = mx - mn
        h = 0.0
        if d > 0:
            if mx == r:
                h = ((g - b) / d) % 6
            elif mx == g:
                h = (b - r) / d + 2
            else:
                h = (r - g) / d + 4
            h /= 6.0
        return (h, d / mx if mx > 0 else 0.0, mx)

    def __add__(self, o):
        return Color([a + b for a, b in zip(self._list(), _seq(o))])

    def __sub__(self, o):
        return Color([a - b for a, b in zip(self._list(), _seq(o))])

    def __mul__(self, f):
        if isinstance(f, (int, float)):
            return Color([a * f for a in self._list()])
        return Color([a * b for a, b in zip(self._list(), _seq(f))])

    __rmul__ = __mul__

    def __truediv__(self, f):
        if f == 0:
            raise ZeroDivisionError("Color division by zero")
        return Color([a / f for a in self._list()])

    def __neg__(self):
        return Color([-a for a in self._list()])

    def __iadd__(self, o):
        self._assign(self + o)
        return self

    def __isub__(self, o):
        self._assign(self - o)
        return self

    def __imul__(self, o):
        self._assign(self * o)
        return self

    def __repr__(self):
        return "Color((%s))" % ", ".join(_fmt(x) for x in self._list())

    def __str__(self):
        return "<Color (r=%.4f, g=%.4f, b=%.4f)>" % (self[0], self[1], self[2])


# linear Rec.709 primaries (the scene linear space) to other spaces; rows map to output channels
_TO_XYZ = ((0.412391, 0.357585, 0.180481), (0.212639, 0.715169, 0.072193), (0.019331, 0.119195, 0.950532))
_TO_ACES = ((0.439633, 0.382989, 0.177378), (0.089776, 0.81344, 0.096784), (0.017541, 0.111547, 0.870912))
_TO_ACESCG = ((0.613097, 0.339522, 0.047379), (0.070194, 0.916355, 0.013453), (0.020616, 0.10957, 0.869815))
_TO_REC2020 = ((0.627404, 0.329284, 0.043314), (0.069097, 0.919541, 0.011363), (0.016391, 0.088013, 0.895595))
_INVERSES = {}


def _inv3(m):
    if m not in _INVERSES:
        _INVERSES[m] = Matrix(m).inverted()._rows
    return _INVERSES[m]


def _axis_matrix(axis, angle):
    c, s = math.cos(angle), math.sin(angle)
    if axis == "X":
        return [[1, 0, 0], [0, c, -s], [0, s, c]]
    if axis == "Y":
        return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]]


def _mul3(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


class Euler(_Base):
    __slots__ = ("_order",)

    def __init__(self, angles=(0.0, 0.0, 0.0), order="XYZ"):
        _Base.__init__(self, angles)
        if order not in ("XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"):
            raise ValueError("Euler(): invalid order '%s'" % order)
        object.__setattr__(self, "_order", order)

    @property
    def order(self):
        return self._order

    @order.setter
    def order(self, v):
        if v not in ("XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"):
            raise ValueError("Euler.order: invalid order")
        object.__setattr__(self, "_order", v)

    x = property(lambda s: s[0], lambda s, v: s.__setitem__(0, v))
    y = property(lambda s: s[1], lambda s, v: s.__setitem__(1, v))
    z = property(lambda s: s[2], lambda s, v: s.__setitem__(2, v))

    def copy(self):
        return Euler(self._list(), self.order)

    def to_matrix(self):
        m = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        idx = {"X": 0, "Y": 1, "Z": 2}
        for ax in self.order:
            m = _mul3(_axis_matrix(ax, self[idx[ax]]), m)
        return Matrix(m)

    def to_quaternion(self):
        return self.to_matrix().to_quaternion()

    def zero(self):
        self._assign((0, 0, 0))

    def make_compatible(self, other):
        o = _seq(other)
        for i in range(3):
            v = self[i]
            d = v - o[i]
            if abs(d) > math.pi:
                v -= round(d / (2 * math.pi)) * 2 * math.pi
            self[i] = v

    def rotate_axis(self, axis, angle):
        """Rotate around one of the rotation's own (local) axes."""
        if axis not in ("X", "Y", "Z"):
            raise ValueError("Euler.rotate_axis(): expected axis 'X', 'Y' or 'Z'")
        m = self.to_matrix() @ Matrix(_axis_matrix(axis, angle))
        self._assign(m.to_euler(self.order, self))

    def rotate(self, other):
        m = (other.to_matrix() if isinstance(other, (Euler, Quaternion)) else other.to_3x3()) @ self.to_matrix()
        self._assign(m.to_euler(self.order, self))

    def __repr__(self):
        return "Euler((%s), '%s')" % (", ".join(_fmt(x) for x in self._list()), self.order)

    def __str__(self):
        return "<Euler (x=%.4f, y=%.4f, z=%.4f), order='%s'>" % (self[0], self[1], self[2], self.order)


class Quaternion(_Base):
    __slots__ = ()

    def __init__(self, seq=(1.0, 0.0, 0.0, 0.0), angle=None):
        if angle is not None:
            ax = Vector(seq).normalized()
            s = math.sin(angle / 2.0)
            _Base.__init__(self, (math.cos(angle / 2.0), ax[0] * s, ax[1] * s, ax[2] * s))
        else:
            v = _seq(seq)
            if len(v) == 3:
                th = math.sqrt(sum(x * x for x in v))
                if th < _EPS:
                    v = [1.0, 0.0, 0.0, 0.0]
                else:
                    s = math.sin(th / 2.0) / th
                    v = [math.cos(th / 2.0), v[0] * s, v[1] * s, v[2] * s]
                    if v[0] < 0:
                        v = [-x for x in v]
            _Base.__init__(self, v)
            if len(self._d) != 4:
                raise ValueError("Quaternion(): expected 4 values (w, x, y, z) or a 3D exponential map")

    w = property(lambda s: s[0], lambda s, v: s.__setitem__(0, v))
    x = property(lambda s: s[1], lambda s, v: s.__setitem__(1, v))
    y = property(lambda s: s[2], lambda s, v: s.__setitem__(2, v))
    z = property(lambda s: s[3], lambda s, v: s.__setitem__(3, v))

    @property
    def magnitude(self):
        return math.sqrt(sum(x * x for x in self._list()))

    @property
    def angle(self):
        w = self.normalized()[0]
        return 2.0 * math.acos(max(-1.0, min(1.0, w)))

    @angle.setter
    def angle(self, a):
        n = self.magnitude or 1.0
        ax = self.axis
        s = math.sin(a / 2.0)
        self._assign((math.cos(a / 2.0) * n, ax[0] * s * n, ax[1] * s * n, ax[2] * s * n))

    @property
    def axis(self):
        q = self.normalized()
        s = math.sqrt(max(0.0, 1.0 - q[0] * q[0]))
        if s < 1e-9:
            return Vector((0.0, 1.0, 0.0))
        return Vector((q[1] / s, q[2] / s, q[3] / s))

    @axis.setter
    def axis(self, v):
        n = self.magnitude or 1.0
        a = self.angle
        ax = Vector(v).normalized()
        s = math.sin(a / 2.0)
        self._assign((math.cos(a / 2.0) * n, ax[0] * s * n, ax[1] * s * n, ax[2] * s * n))

    def to_swing_twist(self, axis):
        """Split into a swing quaternion and a twist angle around 'X', 'Y' or 'Z'."""
        k = {"X": 1, "Y": 2, "Z": 3}.get(axis)
        if k is None:
            raise ValueError("Quaternion.to_swing_twist(): invalid axis '%s'" % axis)
        q = self.normalized()._list()
        t = [q[0], 0.0, 0.0, 0.0]
        t[k] = q[k]
        n = math.hypot(t[0], t[k])
        if n < _EPS:
            t, n = [1.0, 0.0, 0.0, 0.0], 1.0
        t = [x / n for x in t]
        if t[0] < 0:
            t = [-x for x in t]
        angle = 2.0 * math.atan2(t[k], t[0])
        swing = Quaternion(q) @ Quaternion((t[0], -t[1], -t[2], -t[3]))
        return (swing, angle)

    def to_axis_angle(self):
        return (self.axis, self.angle)

    def normalized(self):
        n = self.magnitude
        if n < _EPS:
            return Quaternion()
        return Quaternion([x / n for x in self._list()])

    def normalize(self):
        self._assign(self.normalized())

    def conjugated(self):
        w, x, y, z = self._list()
        return Quaternion((w, -x, -y, -z))

    def conjugate(self):
        self._assign(self.conjugated())

    def inverted(self):
        n = sum(v * v for v in self._list())
        if n < _EPS:
            raise ValueError("Quaternion.inverted(): zero length quaternion has no inverse")
        w, x, y, z = self._list()
        return Quaternion((w / n, -x / n, -y / n, -z / n))

    def invert(self):
        self._assign(self.inverted())

    def identity(self):
        self._assign((1, 0, 0, 0))

    def negate(self):
        self._assign([-v for v in self._list()])

    def dot(self, o):
        return sum(a * b for a, b in zip(self._list(), _seq(o)))

    def cross(self, o):
        return self @ o

    def to_matrix(self):
        w, x, y, z = self.normalized()._list()
        return Matrix((
            (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
            (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
            (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
        ))

    def to_euler(self, order="XYZ", euler_compat=None):
        return self.to_matrix().to_euler(order, euler_compat)

    def to_exponential_map(self):
        return self.axis * self.angle

    def slerp(self, other, factor):
        a = self.normalized()._list()
        b = Quaternion(other).normalized()._list()
        d = sum(p * q for p, q in zip(a, b))
        if d < 0:
            b = [-v for v in b]
            d = -d
        if d > 0.9995:
            return Quaternion([p + (q - p) * factor for p, q in zip(a, b)]).normalized()
        th = math.acos(d)
        s = math.sin(th)
        wa, wb = math.sin((1 - factor) * th) / s, math.sin(factor * th) / s
        return Quaternion([p * wa + q * wb for p, q in zip(a, b)])

    def rotation_difference(self, other):
        return self.inverted() @ Quaternion(other)

    def rotate(self, other):
        q = other if isinstance(other, Quaternion) else other.to_quaternion()
        n = self.magnitude
        self._assign((q.normalized() @ self.normalized()) * n)

    def __truediv__(self, o):
        if o == 0:
            raise ZeroDivisionError("Quaternion division by zero")
        return Quaternion([v / o for v in self._list()])

    def make_compatible(self, other):
        if self.dot(other) < 0:
            self.negate()

    def __matmul__(self, o):
        if isinstance(o, Quaternion):
            aw, ax, ay, az = self._list()
            bw, bx, by, bz = o._list()
            return Quaternion((
                aw * bw - ax * bx - ay * by - az * bz,
                aw * bx + ax * bw + ay * bz - az * by,
                aw * by - ax * bz + ay * bw + az * bx,
                aw * bz + ax * by - ay * bx + az * bw,
            ))
        return self.to_matrix() @ Vector(o)

    def __mul__(self, o):
        if isinstance(o, (int, float)):
            return Quaternion([v * o for v in self._list()])
        return Quaternion([a * b for a, b in zip(self._list(), _seq(o))])

    __rmul__ = __mul__

    def __add__(self, o):
        return Quaternion([a + b for a, b in zip(self._list(), _seq(o))])

    def __sub__(self, o):
        return Quaternion([a - b for a, b in zip(self._list(), _seq(o))])

    def __neg__(self):
        return Quaternion([-v for v in self._list()])

    def __repr__(self):
        return "Quaternion((%s))" % ", ".join(_fmt(x) for x in self._list())

    def __str__(self):
        return "<Quaternion (w=%.4f, x=%.4f, y=%.4f, z=%.4f)>" % tuple(self._list())


class _MatrixRow:
    """A live row view so ``m[0][3] = 1`` writes into the matrix."""

    __slots__ = ("_m", "_r")

    def __init__(self, m, r):
        self._m, self._r = m, r

    def __len__(self):
        return len(self._m._rows[self._r])

    def __getitem__(self, j):
        return self._m._rows[self._r][j]

    def __setitem__(self, j, v):
        if isinstance(j, slice):
            idx = list(range(*j.indices(len(self))))
            for k, x in zip(idx, v):
                self._m._rows[self._r][k] = float(x)
            return
        self._m._rows[self._r][j] = float(v)

    def __iter__(self):
        return iter(list(self._m._rows[self._r]))

    def to_vector(self):
        return Vector(self._m._rows[self._r])

    def __getattr__(self, name):
        return getattr(Vector(self._m._rows[self._r]), name)

    def __add__(self, o):
        return Vector(self._m._rows[self._r]) + o

    def __sub__(self, o):
        return Vector(self._m._rows[self._r]) - o

    def __mul__(self, o):
        return Vector(self._m._rows[self._r]) * o

    def __eq__(self, o):
        return list(self) == list(o)

    def __repr__(self):
        return repr(Vector(self._m._rows[self._r]))


class Matrix:
    __slots__ = ("_rows",)

    def __init__(self, rows=None):
        if rows is None:
            rows = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
        self._rows = [[float(x) for x in r] for r in rows]
        n = len(self._rows)
        if not (2 <= n <= 4) or any(len(r) != len(self._rows[0]) for r in self._rows):
            raise ValueError("Matrix(): expected 2x2 .. 4x4 rows of equal length")

    # constructors
    @classmethod
    def Identity(cls, size=4):
        return cls([[1.0 if i == j else 0.0 for j in range(size)] for i in range(size)])

    @classmethod
    def Translation(cls, v):
        v = _seq(v) + [0.0, 0.0, 0.0]
        m = cls.Identity(4)
        m._rows[0][3], m._rows[1][3], m._rows[2][3] = v[0], v[1], v[2]
        return m

    @classmethod
    def Rotation(cls, angle, size=4, axis="Z"):
        if size == 2:
            c, s = math.cos(angle), math.sin(angle)
            return cls(((c, -s), (s, c)))
        if isinstance(axis, str):
            r = _axis_matrix(axis, angle)
        else:
            r = Quaternion(axis, angle).to_matrix()._rows
        m = cls(r)
        return m.to_4x4() if size == 4 else m

    @classmethod
    def Scale(cls, factor, size=4, axis=None):
        m = cls.Identity(size)
        k = min(size, 3)
        if axis is None:
            for i in range(k):
                m._rows[i][i] = float(factor)
            return m
        n = Vector(axis).normalized()
        for i in range(k):
            for j in range(k):
                m._rows[i][j] += (factor - 1.0) * n[i] * n[j]
        return m

    @classmethod
    def Diagonal(cls, v):
        v = _seq(v)
        m = cls.Identity(len(v))
        for i, x in enumerate(v):
            m._rows[i][i] = x
        return m

    @classmethod
    def OrthoProjection(cls, axis, size=4):
        m = cls.Identity(size)
        if isinstance(axis, str):
            zero = {"X": 1, "Y": 0} if size == 2 else {"XY": 2, "XZ": 1, "YZ": 0}
            if axis not in zero:
                raise ValueError("Matrix.OrthoProjection(): unknown plane '%s'" % axis)
            m._rows[zero[axis]][zero[axis]] = 0.0
            return m
        k = min(size, 3)
        n = Vector(_seq(axis)[:k]).normalized()
        for i in range(k):
            for j in range(k):
                m._rows[i][j] -= n[i] * n[j]
        return m

    @classmethod
    def Shear(cls, plane, size, factor):
        m = cls.Identity(size)
        if size == 2:
            f = factor if isinstance(factor, (int, float)) else _seq(factor)[0]
            if plane == "X":
                m._rows[0][1] = float(f)
            elif plane == "Y":
                m._rows[1][0] = float(f)
            else:
                raise ValueError("Matrix.Shear(): expected plane 'X' or 'Y' for a 2x2 matrix")
            return m
        a, b = (factor, factor) if isinstance(factor, (int, float)) else _seq(factor)[:2]
        cells = {"XY": ((0, 2), (1, 2)), "XZ": ((0, 1), (2, 1)), "YZ": ((1, 0), (2, 0))}
        if plane not in cells:
            raise ValueError("Matrix.Shear(): expected plane 'XY', 'XZ' or 'YZ'")
        (r1, c1), (r2, c2) = cells[plane]
        m._rows[r1][c1], m._rows[r2][c2] = float(a), float(b)
        return m

    @classmethod
    def LocRotScale(cls, location, rotation, scale):
        if rotation is None:
            r = Matrix.Identity(3)
        elif isinstance(rotation, (Euler, Quaternion)):
            r = rotation.to_matrix()
        else:
            r = rotation.to_3x3()
        s = _seq(scale) if scale is not None else [1.0, 1.0, 1.0]
        m = Matrix.Identity(4)
        for i in range(3):
            for j in range(3):
                m._rows[i][j] = r._rows[i][j] * s[j]
        loc = _seq(location) if location is not None else [0.0, 0.0, 0.0]
        for i in range(3):
            m._rows[i][3] = loc[i]
        return m

    # sequence protocol
    def __len__(self):
        return len(self._rows)

    def __getitem__(self, i):
        if isinstance(i, tuple):
            return self._rows[i[0]][i[1]]
        if i < 0:
            i += len(self._rows)
        return _MatrixRow(self, i)

    def __setitem__(self, i, row):
        if isinstance(i, tuple):
            self._rows[i[0]][i[1]] = float(row)
            return
        self._rows[i] = [float(x) for x in row]

    def __iter__(self):
        return iter([_MatrixRow(self, i) for i in range(len(self._rows))])

    @property
    def row(self):
        return [Vector(r) for r in self._rows]

    @property
    def col(self):
        return [Vector([r[j] for r in self._rows]) for j in range(len(self._rows[0]))]

    @property
    def translation(self):
        return Vector((self._rows[0][3], self._rows[1][3], self._rows[2][3]))

    @translation.setter
    def translation(self, v):
        v = _seq(v)
        for i in range(3):
            self._rows[i][3] = v[i]

    @property
    def is_negative(self):
        return self.to_3x3().determinant() < 0

    @property
    def is_orthogonal(self):
        m = self.to_3x3()
        return (m @ m.transposed()).equals(Matrix.Identity(3), 1e-6)

    @property
    def is_orthogonal_axis_vectors(self):
        k = min(len(self._rows), 3)
        cols = [[self._rows[i][j] for i in range(k)] for j in range(k)]
        for a in range(k):
            for b in range(a + 1, k):
                d = sum(x * y for x, y in zip(cols[a], cols[b]))
                n = math.sqrt(sum(x * x for x in cols[a])) * math.sqrt(sum(x * x for x in cols[b]))
                if abs(d) > 1e-6 * max(n, 1e-12):
                    return False
        return True

    @property
    def is_identity(self):
        return self.equals(Matrix.Identity(len(self._rows)), 1e-6)

    @property
    def median_scale(self):
        """Average scale: the length of a unit diagonal vector after transformation."""
        m = self.to_3x3()._rows
        u = 1.0 / math.sqrt(3.0)
        return math.sqrt(sum(((r[0] + r[1] + r[2]) * u) ** 2 for r in m))

    def adjugated(self):
        n = len(self._rows)
        if n == 1:
            return Matrix([[1.0]])

        def minor(i, j):
            sub = [[x for c, x in enumerate(r) if c != j] for k, r in enumerate(self._rows) if k != i]
            return Matrix(sub).determinant() if len(sub) > 1 else sub[0][0]

        return Matrix([[(-1) ** (i + j) * minor(j, i) for j in range(n)] for i in range(n)])

    def adjugate(self):
        self._rows = self.adjugated()._rows

    def copy(self):
        return Matrix(self._rows)

    __copy__ = copy

    def __deepcopy__(self, memo):
        return self.copy()

    def freeze(self):
        return self

    def identity(self):
        n = len(self._rows)
        self._rows = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]

    def zero(self):
        self._rows = [[0.0] * len(r) for r in self._rows]

    def transposed(self):
        return Matrix([[self._rows[i][j] for i in range(len(self._rows))] for j in range(len(self._rows[0]))])

    def transpose(self):
        self._rows = self.transposed()._rows

    def to_3x3(self):
        return Matrix([[self._rows[i][j] if i < len(self._rows) and j < len(self._rows) else (1.0 if i == j else 0.0) for j in range(3)] for i in range(3)])

    def to_4x4(self):
        m = Matrix.Identity(4)
        for i in range(len(self._rows)):
            for j in range(len(self._rows)):
                m._rows[i][j] = self._rows[i][j]
        return m

    def to_2x2(self):
        return Matrix([r[:2] for r in self._rows[:2]])

    def determinant(self):
        def det(m):
            if len(m) == 1:
                return m[0][0]
            if len(m) == 2:
                return m[0][0] * m[1][1] - m[0][1] * m[1][0]
            return sum(((-1) ** j) * m[0][j] * det([r[:j] + r[j + 1:] for r in m[1:]]) for j in range(len(m)))

        return det(self._rows)

    def inverted(self, fallback=None):
        n = len(self._rows)
        a = [list(r) + [1.0 if i == j else 0.0 for j in range(n)] for i, r in enumerate(self._rows)]
        for c in range(n):
            p = max(range(c, n), key=lambda r: abs(a[r][c]))
            if abs(a[p][c]) < 1e-14:
                if fallback is not None:
                    return fallback
                raise ValueError("Matrix.invert(ed): matrix does not have an inverse")
            a[c], a[p] = a[p], a[c]
            d = a[c][c]
            a[c] = [x / d for x in a[c]]
            for r in range(n):
                if r != c and a[r][c]:
                    f = a[r][c]
                    a[r] = [x - f * y for x, y in zip(a[r], a[c])]
        return Matrix([r[n:] for r in a])

    def invert(self, fallback=None):
        self._rows = self.inverted(fallback)._rows

    def inverted_safe(self):
        try:
            return self.inverted()
        except ValueError:
            m = self.copy()
            for i in range(len(m._rows)):
                m._rows[i][i] += 1e-8
            return m.inverted(Matrix.Identity(len(self._rows)))

    def invert_safe(self):
        self._rows = self.inverted_safe()._rows

    def normalized(self):
        m = self.copy()
        for j in range(min(3, len(m._rows))):
            col = [m._rows[i][j] for i in range(min(3, len(m._rows)))]
            n = math.sqrt(sum(x * x for x in col))
            if n > _EPS:
                for i in range(min(3, len(m._rows))):
                    m._rows[i][j] /= n
        return m

    def normalize(self):
        self._rows = self.normalized()._rows

    def to_scale(self):
        m = self.to_3x3()._rows
        s = [math.sqrt(sum(m[i][j] ** 2 for i in range(3))) for j in range(3)]
        if self.to_3x3().determinant() < 0:
            s[0] = -s[0]
        return Vector(s)

    def to_translation(self):
        return self.translation

    def _rot(self):
        m = self.to_3x3()._rows
        s = list(self.to_scale())
        return [[m[i][j] / s[j] if abs(s[j]) > _EPS else 0.0 for j in range(3)] for i in range(3)]

    def to_quaternion(self):
        m = self._rot()
        tr = m[0][0] + m[1][1] + m[2][2]
        if tr > 0:
            s = math.sqrt(tr + 1.0) * 2
            q = (0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s)
        elif m[0][0] > m[1][1] and m[0][0] > m[2][2]:
            s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2
            q = ((m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s)
        elif m[1][1] > m[2][2]:
            s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2
            q = ((m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s)
        else:
            s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2
            q = ((m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s)
        q = Quaternion(q).normalized()
        return -q if q[0] < 0 else q

    def to_euler(self, order="XYZ", euler_compat=None):
        m = self._rot()
        idx = {"X": 0, "Y": 1, "Z": 2}
        i, j, k = idx[order[0]], idx[order[1]], idx[order[2]]
        parity = 1 if (j - i) % 3 == 1 else -1
        a = [0.0, 0.0, 0.0]
        sy = -parity * m[k][i]
        cy = math.hypot(m[k][j], m[k][k])
        if cy > 1e-9:
            a[i] = math.atan2(parity * m[k][j], m[k][k])
            a[j] = math.atan2(sy, cy)
            a[k] = math.atan2(parity * m[j][i], m[i][i])
        else:
            a[i] = math.atan2(-parity * m[j][k], m[j][j])
            a[j] = math.atan2(sy, cy)
            a[k] = 0.0
        e = Euler(a, order)
        if euler_compat is not None:
            e.make_compatible(euler_compat)
        return e

    def decompose(self):
        return (self.to_translation(), self.to_quaternion(), self.to_scale())

    def lerp(self, other, factor):
        return Matrix([[a + (b - a) * factor for a, b in zip(r1, r2)] for r1, r2 in zip(self._rows, other._rows)])

    def equals(self, other, eps=1e-6):
        return len(other) == len(self) and all(abs(a - b) <= eps for r1, r2 in zip(self._rows, other._rows) for a, b in zip(r1, r2))

    def __matmul__(self, o):
        if isinstance(o, Matrix):
            n, m, p = len(self._rows), len(o._rows), len(o._rows[0])
            return Matrix([[sum(self._rows[i][k] * o._rows[k][j] for k in range(m)) for j in range(p)] for i in range(n)])
        if isinstance(o, Quaternion):
            return (self.to_3x3() @ o.to_matrix()).to_quaternion()
        v = _seq(o)
        if len(self._rows[0]) == 4 and len(v) == 3:
            # 3D vector through a 4x4 matrix: w = 1, no perspective divide, truncated to 3D
            r = self._rows
            return Vector([r[i][0] * v[0] + r[i][1] * v[1] + r[i][2] * v[2] + r[i][3] for i in range(3)])
        if len(self._rows) == 3 and len(v) == 4:
            v = v[:3]
        return Vector([sum(a * b for a, b in zip(row, v)) for row in self._rows])

    def __imatmul__(self, o):
        self._rows = (self @ o)._rows
        return self

    def __mul__(self, f):
        if isinstance(f, (int, float)):
            return Matrix([[x * f for x in r] for r in self._rows])
        if isinstance(f, Matrix):
            return Matrix([[a * b for a, b in zip(r1, r2)] for r1, r2 in zip(self._rows, f._rows)])
        return NotImplemented

    __rmul__ = __mul__

    def __add__(self, o):
        return Matrix([[a + b for a, b in zip(r1, r2)] for r1, r2 in zip(self._rows, o._rows)])

    def __sub__(self, o):
        return Matrix([[a - b for a, b in zip(r1, r2)] for r1, r2 in zip(self._rows, o._rows)])

    def __neg__(self):
        return self * -1.0

    def __truediv__(self, f):
        if f == 0:
            raise ZeroDivisionError("Matrix division by zero")
        return self * (1.0 / f)

    def __eq__(self, o):
        return isinstance(o, Matrix) and self._rows == o._rows

    __hash__ = None

    def __repr__(self):
        return "Matrix((%s))" % ",\n        ".join("(%s)" % ", ".join(_fmt(x) for x in r) for r in self._rows)

    def __str__(self):
        return "<Matrix %dx%d %s>" % (len(self._rows), len(self._rows[0]), "\n            ".join("(%s)" % ", ".join("%.4f" % x for x in r) for r in self._rows))


# ---------------------------------------------------------------------------
# Submodules (geometry, kdtree, bvhtree, noise) share one implementation with the
# JavaScript API: calls are forwarded to it through the scripting bridge.

import sys as _sys
import types as _types

_JS = []


def _js(path):
    """The JavaScript `mathutils.<path>` object (resolved through the bridge on first use)."""
    if not _JS:
        import _p3d_bridge

        _JS.append(_p3d_bridge.mathutils())
    o = _JS[0]
    for part in path.split("."):
        o = getattr(o, part)
    return o


def _plain(v):
    if isinstance(v, (Vector, Euler, Quaternion, Color)):
        return [float(x) for x in v]
    if isinstance(v, Matrix):
        return [list(r) for r in v._rows]
    if isinstance(v, (list, tuple, range)) or type(v).__name__ in ("generator", "map", "_MatrixRow"):
        return [_plain(x) for x in v]
    return v


def _tojs(v):
    from pyodide.ffi import to_js

    p = _plain(v)
    return to_js(p) if isinstance(p, list) else p


def _is_null(v):
    return v is None or type(v).__name__ in ("JsNull", "JsUndefined")


def _topy(v):
    if _is_null(v):
        return None
    from pyodide.ffi import JsProxy

    if not isinstance(v, JsProxy):
        return v
    import js

    if js.Array.isArray(v):
        return [_topy(x) for x in v]
    kind = js.Reflect.get(v, "__kind")
    if kind in ("vector", "color", "euler", "quaternion"):
        vals = [float(x) for x in v.toArray()]
        return {"color": Color, "quaternion": Quaternion}.get(kind, Vector)(vals)
    return v


_PY_ERRORS = {"TypeError": TypeError, "ValueError": ValueError, "RuntimeError": RuntimeError, "IndexError": IndexError, "AttributeError": AttributeError, "RangeError": ValueError}


def _call(fn, *args):
    from pyodide.ffi import JsException

    try:
        return fn(*args)
    except JsException as e:
        msg = str(e)
        for name, cls in _PY_ERRORS.items():
            k = msg.find(name + ": ")
            if k >= 0:
                raise cls(msg[k + len(name) + 2:]) from None
        raise RuntimeError(msg) from None


def _fwd(path, *args):
    return _topy(_call(_js(path), *[_tojs(a) for a in args]))


def _vecs(r):
    return tuple(r) if isinstance(r, list) else r


def _f(x):
    return None if x is None else float(x)


def _module(name, doc, fns):
    m = _types.ModuleType("mathutils." + name, doc)
    for f in fns:
        setattr(m, f.__name__, f)
        f.__module__ = m.__name__
    _sys.modules[m.__name__] = m
    return m


# --- geometry ---------------------------------------------------------------

def intersect_ray_tri(v1, v2, v3, ray, orig, clip=True):
    """Ray (direction `ray` from `orig`) against a triangle; None when it misses."""
    return _fwd("geometry.intersect_ray_tri", v1, v2, v3, ray, orig, bool(clip))


def intersect_line_line(v1, v2, v3, v4):
    """Closest points between two infinite lines, or None when parallel."""
    return _vecs(_fwd("geometry.intersect_line_line", v1, v2, v3, v4))


def intersect_line_line_2d(lineA_p1, lineA_p2, lineB_p1, lineB_p2):
    return _fwd("geometry.intersect_line_line_2d", lineA_p1, lineA_p2, lineB_p1, lineB_p2)


def intersect_line_plane(line_a, line_b, plane_co, plane_no, no_flip=False):
    return _fwd("geometry.intersect_line_plane", line_a, line_b, plane_co, plane_no, bool(no_flip))


def intersect_plane_plane(plane_a_co, plane_a_no, plane_b_co, plane_b_no):
    return _vecs(_fwd("geometry.intersect_plane_plane", plane_a_co, plane_a_no, plane_b_co, plane_b_no))


def intersect_line_sphere(line_a, line_b, sphere_co, sphere_radius, clip=True):
    return _vecs(_fwd("geometry.intersect_line_sphere", line_a, line_b, sphere_co, float(sphere_radius), bool(clip)))


def intersect_line_sphere_2d(line_a, line_b, sphere_co, sphere_radius, clip=True):
    return _vecs(_fwd("geometry.intersect_line_sphere_2d", line_a, line_b, sphere_co, float(sphere_radius), bool(clip)))


def intersect_sphere_sphere_2d(p_a, radius_a, p_b, radius_b):
    return _vecs(_fwd("geometry.intersect_sphere_sphere_2d", p_a, float(radius_a), p_b, float(radius_b)))


def intersect_point_line(pt, line_p1, line_p2):
    p, t = _fwd("geometry.intersect_point_line", pt, line_p1, line_p2)
    return (p, float(t))


def intersect_point_tri(pt, tri_p1, tri_p2, tri_p3):
    return _fwd("geometry.intersect_point_tri", pt, tri_p1, tri_p2, tri_p3)


def intersect_point_tri_2d(pt, tri_p1, tri_p2, tri_p3):
    return int(_fwd("geometry.intersect_point_tri_2d", pt, tri_p1, tri_p2, tri_p3))


def intersect_point_quad_2d(pt, quad_p1, quad_p2, quad_p3, quad_p4):
    return int(_fwd("geometry.intersect_point_quad_2d", pt, quad_p1, quad_p2, quad_p3, quad_p4))


def intersect_tri_tri_2d(tri_a1, tri_a2, tri_a3, tri_b1, tri_b2, tri_b3):
    return bool(_fwd("geometry.intersect_tri_tri_2d", tri_a1, tri_a2, tri_a3, tri_b1, tri_b2, tri_b3))


def closest_point_on_tri(pt, tri_p1, tri_p2, tri_p3):
    return _fwd("geometry.closest_point_on_tri", pt, tri_p1, tri_p2, tri_p3)


def distance_point_to_plane(pt, plane_co, plane_no):
    return float(_fwd("geometry.distance_point_to_plane", pt, plane_co, plane_no))


def area_tri(v1, v2, v3):
    return float(_fwd("geometry.area_tri", v1, v2, v3))


def volume_tri(v1, v2, v3):
    """Signed volume of the tetrahedron (v1, v2, v3, origin)."""
    return float(_fwd("geometry.volume_tri", v1, v2, v3))


def normal(*vectors):
    """Unit normal of a polygon given as points (or one sequence of points)."""
    if len(vectors) == 1:
        vectors = vectors[0]
    return _fwd("geometry.normal", list(vectors))


def barycentric_transform(point, tri_a1, tri_a2, tri_a3, tri_b1, tri_b2, tri_b3):
    return _fwd("geometry.barycentric_transform", point, tri_a1, tri_a2, tri_a3, tri_b1, tri_b2, tri_b3)


def interpolate_bezier(knot1, handle1, handle2, knot2, resolution):
    return _fwd("geometry.interpolate_bezier", knot1, handle1, handle2, knot2, int(resolution))


def tessellate_polygon(veclist_list):
    """Triangles (index triples into the points of all loops in order) filling the loops."""
    return [tuple(int(i) for i in t) for t in _fwd("geometry.tessellate_polygon", [list(loop) for loop in veclist_list])]


def convex_hull_2d(points):
    return [int(i) for i in _fwd("geometry.convex_hull_2d", list(points))]


def box_fit_2d(points):
    return float(_fwd("geometry.box_fit_2d", list(points)))


def box_pack_2d(boxes):
    """Pack boxes [x, y, width, height]; x and y are written in place. Returns (width, height)."""
    arr = _tojs([list(b) for b in boxes])
    w, h = _topy(_call(_js("geometry.box_pack_2d"), arr))
    for b, placed in zip(boxes, arr):
        b[0], b[1] = float(placed[0]), float(placed[1])
    return (float(w), float(h))


def points_in_planes(planes, epsilon_coplanar=1e-4, epsilon_isect=1e-6):
    verts, used = _fwd("geometry.points_in_planes", list(planes), float(epsilon_coplanar), float(epsilon_isect))
    return (verts, [int(i) for i in used])


geometry = _module(
    "geometry",
    "Intersection, projection and polygon helpers.",
    [intersect_ray_tri, intersect_line_line, intersect_line_line_2d, intersect_line_plane, intersect_plane_plane, intersect_line_sphere,
     intersect_line_sphere_2d, intersect_sphere_sphere_2d, intersect_point_line, intersect_point_tri, intersect_point_tri_2d,
     intersect_point_quad_2d, intersect_tri_tri_2d, closest_point_on_tri, distance_point_to_plane, area_tri, volume_tri, normal,
     barycentric_transform, interpolate_bezier, tessellate_polygon, convex_hull_2d, box_fit_2d, box_pack_2d, points_in_planes],
)


# --- kdtree -----------------------------------------------------------------

def _xyz(co):
    v = _seq(co)
    return float(v[0]), float(v[1]), float(v[2]) if len(v) > 2 else 0.0


def _hits5(flat, n=5):
    flat = list(flat)
    return [(Vector(flat[i:i + 3]), int(flat[i + 3]), float(flat[i + 4])) for i in range(0, len(flat), n)]


class KDTree:
    """Balanced 3D k-d tree: insert points, balance(), then search."""

    def __init__(self, size):
        size = int(size)
        if size < 0:
            raise ValueError("KDTree(size): size must be a non-negative integer")
        self._size = size
        self._co = []
        self._ids = []
        self._tree = None

    def insert(self, co, index):
        if len(self._ids) >= self._size:
            raise RuntimeError("Trying to insert more items than KDTree has room for")
        self._co.extend(_xyz(co))
        self._ids.append(int(index))
        self._tree = None

    def balance(self):
        from pyodide.ffi import to_js

        tree = _call(_js("kdtree.KDTree").new, self._size)
        _call(tree._insertFlat, to_js(self._co), to_js(self._ids))
        _call(tree.balance)
        self._tree = tree

    def _t(self, what):
        if self._tree is None:
            raise RuntimeError("KDTree must be balanced before calling %s()" % what)
        return self._tree

    def find(self, co, filter=None):
        """Nearest point: (co, index, distance), or (None, None, None)."""
        x, y, z = _xyz(co)
        r = _call(self._t("find")._findFlat, x, y, z, filter)
        hits = _hits5(r)
        return hits[0] if hits else (None, None, None)

    def find_n(self, co, n):
        x, y, z = _xyz(co)
        return _hits5(_call(self._t("find_n")._findNFlat, x, y, z, int(n)))

    def find_range(self, co, radius):
        x, y, z = _xyz(co)
        return _hits5(_call(self._t("find_range")._findRangeFlat, x, y, z, float(radius)))

    def __repr__(self):
        return "<KDTree object (%d points)>" % len(self._ids)


kdtree = _module("kdtree", "Balanced k-d tree for nearest-point queries.", [])
kdtree.KDTree = KDTree
KDTree.__module__ = "mathutils.kdtree"


# --- bvhtree ----------------------------------------------------------------

_NO_HIT = (None, None, None, None)


def _hits8(flat):
    flat = list(flat)
    return [(Vector(flat[i:i + 3]), Vector(flat[i + 3:i + 6]), int(flat[i + 6]), float(flat[i + 7])) for i in range(0, len(flat), 8)]


def _flat_mesh(vertices, polygons):
    pos, offs, idx = [], [0], []
    for v in vertices:
        pos.extend(_xyz(v))
    for p in polygons:
        idx.extend(int(i) for i in p)
        offs.append(len(idx))
    return pos, offs, idx


class BVHTree:
    """Bounding volume hierarchy over mesh triangles; build with the From* class methods."""

    def __init__(self, tree=None):
        if tree is None:
            raise TypeError("BVHTree: use BVHTree.FromPolygons, FromObject or FromBMesh")
        self._js = tree

    @classmethod
    def FromPolygons(cls, vertices, polygons, all_triangles=False, epsilon=0.0):
        from pyodide.ffi import to_js

        pos, offs, idx = _flat_mesh(vertices, polygons)
        return cls(_call(_js("bvhtree.BVHTree")._fromFlat, to_js(pos), to_js(offs), to_js(idx), bool(all_triangles), float(epsilon)))

    @classmethod
    def FromObject(cls, object, depsgraph=None, deform=True, render=False, cage=False, epsilon=0.0):
        ob = getattr(object, "_js", None)
        if ob is None:
            raise TypeError("BVHTree.FromObject(): expected an Object")
        return cls(_call(_js("bvhtree.BVHTree").FromObject, ob, None, bool(deform), bool(render), bool(cage), float(epsilon)))

    @classmethod
    def FromBMesh(cls, bmesh, epsilon=0.0):
        jsbm = getattr(bmesh, "_js", None)
        if jsbm is not None:
            return cls(_call(_js("bvhtree.BVHTree").FromBMesh, jsbm, float(epsilon)))
        verts = list(bmesh.verts)
        upd = getattr(bmesh.verts, "index_update", None)
        if callable(upd):
            upd()
        slot = {id(v): i for i, v in enumerate(verts)}
        polys = [[slot[id(v)] if id(v) in slot else v.index for v in f.verts] for f in bmesh.faces]
        return cls.FromPolygons([v.co for v in verts], polys, False, epsilon)

    def ray_cast(self, origin, direction, distance=float("inf")):
        """First hit along the ray: (location, normal, index, distance) or four Nones."""
        ox, oy, oz = _xyz(origin)
        dx, dy, dz = _xyz(direction)
        hits = _hits8(_call(self._js._rayFlat, ox, oy, oz, dx, dy, dz, float(distance)))
        return hits[0] if hits else _NO_HIT

    def find_nearest(self, origin, distance=float("inf")):
        x, y, z = _xyz(origin)
        hits = _hits8(_call(self._js._nearestFlat, x, y, z, float(distance)))
        return hits[0] if hits else _NO_HIT

    def find_nearest_range(self, origin, distance=float("inf")):
        x, y, z = _xyz(origin)
        return _hits8(_call(self._js._rangeFlat, x, y, z, float(distance)))

    def overlap(self, other_tree):
        if not isinstance(other_tree, BVHTree):
            raise TypeError("BVHTree.overlap(): expected a BVHTree")
        flat = list(_call(self._js._overlapFlat, other_tree._js))
        return [(int(flat[i]), int(flat[i + 1])) for i in range(0, len(flat), 2)]

    def __repr__(self):
        return str(self._js.toString())


bvhtree = _module("bvhtree", "Bounding volume hierarchy for ray casts and proximity queries.", [])
bvhtree.BVHTree = BVHTree
BVHTree.__module__ = "mathutils.bvhtree"


# --- noise ------------------------------------------------------------------

def seed_set(seed):
    """Seed the random functions."""
    _fwd("noise.seed_set", int(seed))


def random():
    return float(_fwd("noise.random"))


def random_unit_vector(size=3):
    return _fwd("noise.random_unit_vector", int(size))


def random_vector(size=3):
    return _fwd("noise.random_vector", int(size))


def noise(position, noise_basis="PERLIN_ORIGINAL"):
    return float(_fwd("noise.noise", position, noise_basis))


def noise_vector(position, noise_basis="PERLIN_ORIGINAL"):
    return _fwd("noise.noise_vector", position, noise_basis)


def turbulence(position, octaves, hard, noise_basis="PERLIN_ORIGINAL", amplitude_scale=0.5, frequency_scale=2.0):
    return float(_fwd("noise.turbulence", position, int(octaves), bool(hard), noise_basis, float(amplitude_scale), float(frequency_scale)))


def turbulence_vector(position, octaves, hard, noise_basis="PERLIN_ORIGINAL", amplitude_scale=0.5, frequency_scale=2.0):
    return _fwd("noise.turbulence_vector", position, int(octaves), bool(hard), noise_basis, float(amplitude_scale), float(frequency_scale))


def fractal(position, H, lacunarity, octaves, noise_basis="PERLIN_ORIGINAL"):
    return float(_fwd("noise.fractal", position, float(H), float(lacunarity), float(octaves), noise_basis))


def multi_fractal(position, H, lacunarity, octaves, noise_basis="PERLIN_ORIGINAL"):
    return float(_fwd("noise.multi_fractal", position, float(H), float(lacunarity), float(octaves), noise_basis))


def hetero_terrain(position, H, lacunarity, octaves, offset, noise_basis="PERLIN_ORIGINAL"):
    return float(_fwd("noise.hetero_terrain", position, float(H), float(lacunarity), float(octaves), float(offset), noise_basis))


def hybrid_multi_fractal(position, H, lacunarity, octaves, offset, gain, noise_basis="PERLIN_ORIGINAL"):
    return float(_fwd("noise.hybrid_multi_fractal", position, float(H), float(lacunarity), float(octaves), float(offset), float(gain), noise_basis))


def ridged_multi_fractal(position, H, lacunarity, octaves, offset, gain, noise_basis="PERLIN_ORIGINAL"):
    return float(_fwd("noise.ridged_multi_fractal", position, float(H), float(lacunarity), float(octaves), float(offset), float(gain), noise_basis))


def variable_lacunarity(position, distortion, noise_type1="PERLIN_ORIGINAL", noise_type2="PERLIN_ORIGINAL"):
    return float(_fwd("noise.variable_lacunarity", position, float(distortion), noise_type1, noise_type2))


def cell(position):
    return float(_fwd("noise.cell", position))


def cell_vector(position):
    return _fwd("noise.cell_vector", position)


def voronoi(position, distance_metric="DISTANCE", exponent=2.5):
    d, p = _fwd("noise.voronoi", position, distance_metric, float(exponent))
    return [[float(x) for x in d], p]


noise = _module(
    "noise",
    "Deterministic procedural noise and random numbers.",
    [seed_set, random, random_unit_vector, random_vector, noise, noise_vector, turbulence, turbulence_vector, fractal, multi_fractal,
     hetero_terrain, hybrid_multi_fractal, ridged_multi_fractal, variable_lacunarity, cell, cell_vector, voronoi],
)

# keep the module namespace to the public names (the functions live in the submodules)
for _name in list(geometry.__dict__) + list(noise.__dict__):
    if not _name.startswith("_") and _name not in ("geometry", "noise") and globals().get(_name) is getattr(geometry, _name, getattr(noise, _name, None)):
        del globals()[_name]
del _name
