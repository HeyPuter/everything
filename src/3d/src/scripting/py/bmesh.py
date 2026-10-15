"""Editable meshes for scripts: ``bmesh.new()``, ``bmesh.from_edit_mesh(me)``,
``bmesh.ops``, ``bmesh.types``, ``bmesh.utils`` and ``bmesh.geometry``.

A thin Python layer over the JavaScript implementation that JavaScript scripts use as
the ``bmesh`` global: elements, sequences and layers are live views of the same objects.
"""

import js
from pyodide.ffi import JsProxy
import _p3d_bridge as _br
import bpy

__all__ = ("new", "from_edit_mesh", "update_edit_mesh", "ops", "types", "utils", "geometry")

_js = _br.module("bmesh")
_call = bpy._call
_tojs = bpy._tojs
_kwargs = bpy._kwargs
_is_null = bpy._is_null
_orig_wrap = bpy._wrap


def _jscall(obj, name, args, kw):
    return _wrap(_call(_br.call, obj, name, _tojs(list(args)), _kwargs(kw)))


# ---------------------------------------------------------------------------
# Python classes for values that need dict / sequence behaviour beyond bpy's wrappers

class _ElemSeq(bpy._Collection):
    """BMVertSeq / BMEdgeSeq / BMFaceSeq."""

    __slots__ = ()

    def sort(self, key=None, reverse=False):
        items = list(self)
        order = list(range(len(items)))
        if key is not None:
            order.sort(key=lambda i: key(items[i]))
        if reverse:
            order.reverse()
        _call(_br.call, self._js, "_sort_order", _tojs([order]), js.Object.new())


class _DeformVert(bpy._Struct):
    """Vertex-group weights of one vertex: a dict of group index -> weight."""

    __slots__ = ()

    def __len__(self):
        return int(_br.len(self._js))

    def keys(self):
        return [int(k) for k in _call(_br.call, self._js, "keys", js.Array.new(), js.Object.new())]

    def values(self):
        return [float(w) for w in _call(_br.call, self._js, "values", js.Array.new(), js.Object.new())]

    def items(self):
        return list(zip(self.keys(), self.values()))

    def __iter__(self):
        return iter(self.keys())

    def __getitem__(self, key):
        return float(_call(_br.getitem, self._js, int(key)))

    def __setitem__(self, key, value):
        _call(_br.setitem, self._js, int(key), float(value))

    def __delitem__(self, key):
        _call(_br.delitem, self._js, int(key))

    def __contains__(self, key):
        return isinstance(key, int) and bool(_call(_br.contains, self._js, key))

    def get(self, key, default=None):
        return float(self[key]) if key in self else default

    def clear(self):
        _call(_br.call, self._js, "clear", js.Array.new(), js.Object.new())

    def __repr__(self):
        return "<BMDeformVert %r>" % dict(self.items())


_PYCLASS = {"seq": _ElemSeq, "deform": _DeformVert}


def _wrap(v):
    if isinstance(v, JsProxy):
        try:
            tag = getattr(v, "_bmpy")
        except Exception:
            tag = None
        if tag is not None and not _is_null(tag):
            cls = _PYCLASS.get(str(tag))
            if cls is not None:
                return cls(v)
    return _orig_wrap(v)


bpy._wrap = _wrap


def _result(r):
    """Operator results as a dict (maps of elements become dicts)."""
    if _is_null(r):
        return None
    out = {}
    for item in _call(_br.call, _js, "_result_items", _tojs([r]), js.Object.new()):
        key, value, is_map = str(item[0]), item[1], bool(item[2])
        if is_map:
            out[key] = {_wrap(p[0]): _wrap(p[1]) for p in value}
        else:
            out[key] = _wrap(value)
    return out


# ---------------------------------------------------------------------------
# module functions

def new(use_operators=True):
    """A new, empty BMesh."""
    return _jscall(_js, "new", [use_operators], {})


def from_edit_mesh(mesh):
    """The BMesh of a mesh in Edit Mode (reflects the current selection)."""
    return _jscall(_js, "from_edit_mesh", [mesh], {})


def update_edit_mesh(mesh, loop_triangles=True, destructive=True):
    """Write the Edit Mode BMesh back to the mesh so the viewport shows the changes."""
    return _jscall(_js, "update_edit_mesh", [mesh, loop_triangles, destructive], {})


class _Ops:
    """bmesh.ops: operators taking the BMesh first, then keyword arguments."""

    def __init__(self):
        self._jsops = _br.getattr(_js, "ops")
        self._names = None

    def _all(self):
        if self._names is None:
            self._names = [str(n) for n in _call(_br.call, _js, "_op_names", js.Array.new(), js.Object.new())]
        return self._names

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if name not in self._all():
            raise AttributeError("bmesh.ops has no operator '%s'. Available: %s" % (name, ", ".join(self._all())))
        jsops = self._jsops

        def op(bm, *args, **kw):
            if args:
                raise TypeError("bmesh.ops.%s(): takes the BMesh and keyword arguments only" % name)
            return _result(_call(_br.call, jsops, name, _tojs([bm]), _kwargs(kw)))

        op.__name__ = name
        return op

    def __dir__(self):
        return list(self._all())

    def __repr__(self):
        return "<module 'bmesh.ops'>"


ops = _Ops()


class _Namespace:
    def __init__(self, name):
        self._name = name
        self._obj = _br.getattr(_js, name)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        if _br.attrkind(self._obj, name) != "method":
            raise AttributeError("bmesh.%s has no attribute '%s'" % (self._name, name))
        obj = self._obj

        def fn(*args, **kw):
            r = _jscall(obj, name, args, kw)
            return tuple(r) if isinstance(r, list) else r

        fn.__name__ = name
        return fn

    def __dir__(self):
        return list(_br.dir(self._obj).to_py())

    def __repr__(self):
        return "<module 'bmesh.%s'>" % self._name


utils = _Namespace("utils")
geometry = _Namespace("geometry")


class _Types:
    """bmesh.types: classes for isinstance() checks."""

    def __repr__(self):
        return "<module 'bmesh.types'>"


types = _Types()
for _n in (
    "BMesh", "BMVert", "BMEdge", "BMFace", "BMLoop", "BMElemSeq", "BMVertSeq", "BMEdgeSeq", "BMFaceSeq",
    "BMLoopSeq", "BMIter", "BMEditSelSeq", "BMEditSelIter", "BMLayerAccessVert", "BMLayerAccessEdge",
    "BMLayerAccessFace", "BMLayerAccessLoop", "BMLayerCollection", "BMLayerItem", "BMLoopUV", "BMDeformVert",
):
    setattr(types, _n, bpy._TypeMeta(_n, (), {}))
del _n
