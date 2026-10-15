"""Scripting API for this application, exposing the familiar ``bpy`` layout.

This is a thin Python layer over the JavaScript object model (``_p3d_bridge``): every
attribute access, item lookup and method call is forwarded to the document, so values
are always live. Supported: bpy.data, bpy.context, bpy.ops, bpy.types (Operator, Panel),
bpy.props, bpy.utils (register_class / unregister_class), bpy.app, bpy.path.
"""

import sys
import _p3d_bridge as _br
from pyodide.ffi import JsProxy, JsException, to_js, create_proxy
import js
import mathutils

__all__ = ("data", "context", "ops", "types", "props", "utils", "app", "path")

_ERRORS = {
    "AttributeError": AttributeError,
    "TypeError": TypeError,
    "KeyError": KeyError,
    "IndexError": IndexError,
    "ValueError": ValueError,
    "RuntimeError": RuntimeError,
    "ReferenceError": ReferenceError,
    "RangeError": ValueError,
}


def _convert_error(e):
    msg = str(e)
    for prefix in ("PythonError: ", "Error: "):
        if msg.startswith(prefix):
            msg = msg[len(prefix):]
    for name, cls in _ERRORS.items():
        tag = name + ": "
        k = msg.find(tag)
        if k < 0:
            continue
        body = msg[k + len(tag):]
        while body.startswith(tag):
            body = body[len(tag):]
        if cls is KeyError and len(body) > 1 and body[0] == body[-1] == "'":
            body = body[1:-1]
        return cls(body)
    return RuntimeError(msg)


def _call(fn, *args):
    try:
        return fn(*args)
    except JsException as e:
        raise _convert_error(e) from None


# ---------------------------------------------------------------------------
# Python -> JavaScript

def _tojs(v):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, _Struct):
        return v._js
    if isinstance(v, (mathutils.Vector, mathutils.Euler, mathutils.Quaternion, mathutils.Color)):
        return to_js([float(x) for x in v])
    if isinstance(v, mathutils.Matrix):
        return _br.matrix(to_js([[float(x) for x in r] for r in v._rows]))
    if isinstance(v, JsProxy):
        return v
    if isinstance(v, dict):
        o = js.Object.new()
        for k, x in v.items():
            js.Reflect.set(o, str(k), _tojs(x))
        return o
    if isinstance(v, (list, tuple, set, frozenset, range)):
        arr = js.Array.new()
        for x in v:
            arr.push(_tojs(x))
        return arr
    if hasattr(v, "__iter__"):
        return _tojs(list(v))
    return v


def _kwargs(kw):
    o = js.Object.new()
    for k, x in kw.items():
        js.Reflect.set(o, k, _tojs(x))
    return o


# ---------------------------------------------------------------------------
# JavaScript -> Python

def _is_null(v):
    return v is None or type(v).__name__ in ("JsNull", "JsUndefined")


def _wrap(v):
    if _is_null(v):
        return None
    if not isinstance(v, JsProxy):
        return v
    kind = _br.wrapkind(v)
    if kind.startswith("b:"):
        _, k, n = kind.split(":")
        return _BOUND[k](v, int(n))
    if kind in ("vector", "euler", "color", "quaternion"):
        vals = list(_br.components(v).to_py())
        if kind == "euler":
            return mathutils.Euler(vals, _br.order(v))
        return {"vector": mathutils.Vector, "color": mathutils.Color, "quaternion": mathutils.Quaternion}[kind](vals)
    if kind == "matrix":
        return mathutils.Matrix(_br.rows(v).to_py())
    if kind == "collection":
        return _Collection(v)
    if kind == "array":
        return _Array(v)
    if kind == "jsarray":
        return [_wrap(x) for x in v]
    if kind == "set":
        return {_wrap(x) for x in v}
    if kind == "function":
        return _Function(v)
    if kind == "opmodule":
        return _OpsModule(_br.getattr(v, "__module"))
    return _Struct(v)


_METHOD = "\x00method"


class _Function:
    __slots__ = ("_fn",)

    def __init__(self, fn):
        self._fn = fn

    def __call__(self, *args, **kw):
        return _wrap(_call(_br.callf, self._fn, _tojs(list(args)), _kwargs(kw)))

    def __repr__(self):
        return "<built-in function>"


class _Method:
    __slots__ = ("_obj", "_name")

    def __init__(self, obj, name):
        self._obj, self._name = obj, name

    def __call__(self, *args, **kw):
        return _wrap(_call(_br.call, self._obj, self._name, _tojs(list(args)), _kwargs(kw)))

    def __repr__(self):
        return "<bpy_func %s>" % self._name


class _Struct:
    """Live view of a document struct (Object, Mesh, Material, Scene, Modifier, ...)."""

    __slots__ = ("_js",)

    def __init__(self, jsobj):
        object.__setattr__(self, "_js", jsobj)

    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        v = _call(_br.attr, self._js, name)
        if v == _METHOD:
            return _Method(self._js, name)
        return _wrap(v)

    def __setattr__(self, name, value):
        _call(_br.setattr, self._js, name, _tojs(value))

    def __delattr__(self, name):
        raise AttributeError("cannot delete attribute '%s'" % name)

    def __getitem__(self, key):
        return _wrap(_call(_br.getitem, self._js, _tojs(key)))

    def __setitem__(self, key, value):
        _call(_br.setitem, self._js, _tojs(key), _tojs(value))

    def __delitem__(self, key):
        _call(_br.delitem, self._js, _tojs(key))

    def __contains__(self, key):
        return bool(_call(_br.contains, self._js, _tojs(key)))

    def get(self, key, default=None):
        if _br.attrkind(self._js, "get") == "method":
            return _wrap(_call(_br.call, self._js, "get", _tojs([key, default]), js.Object.new()))
        return default

    def keys(self):
        return list(_call(_br.call, self._js, "keys", js.Array.new(), js.Object.new()).to_py())

    def __eq__(self, other):
        return isinstance(other, _Struct) and bool(_br.same(self._js, other._js))

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return hash(_br.key(self._js))

    def __repr__(self):
        return _br.repr(self._js)

    def __str__(self):
        return _br.str(self._js)

    def __dir__(self):
        return list(_br.dir(self._js).to_py())

    def __bool__(self):
        return True

    @property
    def bl_rna(self):
        return _wrap(_br.getattr(self._js, "bl_rna"))


class _Collection(_Struct):
    """bpy_prop_collection: ``coll["Name"]``, ``coll[0]``, ``len``, iteration, ``get``, ``new``, ``remove``."""

    __slots__ = ()

    def __len__(self):
        return int(_call(_br.len, self._js))

    def __iter__(self):
        return iter([_wrap(x) for x in _call(_br.list, self._js)])

    def __getitem__(self, key):
        if isinstance(key, slice):
            return [_wrap(x) for x in _call(_br.list, self._js)][key]
        return _wrap(_call(_br.getitem, self._js, _tojs(key)))

    def __setitem__(self, key, value):
        if isinstance(key, slice):
            if key.step not in (None, 1):
                raise ValueError("slice assignment with a step is not supported")
            _call(_br.call, self._js, "set_slice", _tojs([key.start, key.stop, list(value)]), js.Object.new())
            return
        _call(_br.setitem, self._js, _tojs(key), _tojs(value))

    def __contains__(self, key):
        return bool(_call(_br.contains, self._js, _tojs(key)))

    def __bool__(self):
        return len(self) > 0

    def get(self, key, default=None):
        r = _call(_br.call, self._js, "get", _tojs([key]), js.Object.new())
        return default if _is_null(r) else _wrap(r)

    def keys(self):
        return [str(k) for k in _call(_br.call, self._js, "keys", js.Array.new(), js.Object.new())]

    def values(self):
        return list(self)

    def items(self):
        return list(zip(self.keys(), self.values()))

    def find(self, key, *args, **kw):
        r = _call(_br.call, self._js, "find", _tojs([key, *args]), _kwargs(kw))
        return r if not isinstance(r, (int, float)) else int(r)

    def foreach_get(self, attr, seq=None):
        # arrays such as Image.pixels take only the buffer
        args = [] if seq is None else [attr]
        if seq is None:
            seq = attr
        vals = list(_call(_br.call, self._js, "foreach_get", _tojs(args), js.Object.new()))
        for i, v in enumerate(vals):
            if i < len(seq):
                seq[i] = v

    def foreach_set(self, attr, seq=None):
        args = [list(attr)] if seq is None else [attr, list(seq)]
        _call(_br.call, self._js, "foreach_set", _tojs(args), js.Object.new())


class _Array(_Collection):
    __slots__ = ()


# ---------------------------------------------------------------------------
# bound vectors (live views onto document arrays)

class _BoundMixin:
    __slots__ = ()

    def _len(self):
        return self._n

    def _getc(self, i):
        return float(_br.vget(self._js, i))

    def _setc(self, i, v):
        _call(_br.vset, self._js, i, float(v))


class _BoundVector(_BoundMixin, mathutils.Vector):
    __slots__ = ("_js", "_n")

    def __init__(self, jsobj, n=None):
        object.__setattr__(self, "_js", jsobj)
        object.__setattr__(self, "_n", int(_br.vlen(jsobj)) if n is None else n)

    def copy(self):
        return mathutils.Vector(self._list())


class _BoundColor(_BoundMixin, mathutils.Color):
    __slots__ = ("_js", "_n")

    def __init__(self, jsobj, n=None):
        object.__setattr__(self, "_js", jsobj)
        object.__setattr__(self, "_n", int(_br.vlen(jsobj)) if n is None else n)

    def copy(self):
        return mathutils.Color(self._list())


class _BoundQuaternion(_BoundMixin, mathutils.Quaternion):
    __slots__ = ("_js", "_n")

    def __init__(self, jsobj, n=None):
        object.__setattr__(self, "_js", jsobj)
        object.__setattr__(self, "_n", int(_br.vlen(jsobj)) if n is None else n)

    def copy(self):
        return mathutils.Quaternion(self._list())


class _BoundEuler(_BoundMixin, mathutils.Euler):
    __slots__ = ("_js", "_n")

    def __init__(self, jsobj, n=None):
        object.__setattr__(self, "_js", jsobj)
        object.__setattr__(self, "_n", int(_br.vlen(jsobj)) if n is None else n)
        object.__setattr__(self, "_order", str(_br.order(jsobj)))

    def copy(self):
        return mathutils.Euler(self._list(), self.order)


_BOUND = {"vector": _BoundVector, "color": _BoundColor, "quaternion": _BoundQuaternion, "euler": _BoundEuler}


# ---------------------------------------------------------------------------
# bpy.ops

class _Op:
    __slots__ = ("_idname",)

    def __init__(self, idname):
        self._idname = idname

    def __call__(self, *args, **kw):
        ctx = "EXEC_DEFAULT"
        for a in args:
            if isinstance(a, str):
                ctx = a
            elif isinstance(a, dict):
                pass  # context override dictionaries are accepted and ignored
        res = _call(_br.op, self._idname, _kwargs(kw), ctx)
        return {str(res)}

    def poll(self, *args):
        return bool(_br.op_poll(self._idname))

    def idname(self):
        return self._idname.upper().replace(".", "_OT_", 1)

    def idname_py(self):
        return self._idname

    def get_rna_type(self):
        return _Struct(_br.op_info(self._idname))

    def __repr__(self):
        doc = _br.op_description(self._idname)
        return "# %s\nbpy.ops.%s()" % (doc, self._idname)


class _OpsModule:
    __slots__ = ("_mod",)

    def __init__(self, mod):
        object.__setattr__(self, "_mod", mod)

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        idname = "%s.%s" % (self._mod, name)
        if not _br.op_exists(idname):
            raise AttributeError('Calling operator "bpy.ops.%s" error, could not be found' % idname)
        return _Op(idname)

    def __dir__(self):
        return list(_br.op_names(self._mod).to_py())

    def __repr__(self):
        return "<module like class 'bpy.ops.%s'>" % self._mod


class _Ops:
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        if name not in self.__dir__():
            raise AttributeError("bpy.ops has no module '%s'" % name)
        return _OpsModule(name)

    def __dir__(self):
        return list(_br.op_modules().to_py())

    def __repr__(self):
        return "<module like class 'bpy.ops'>"


ops = _Ops()

# ---------------------------------------------------------------------------
# bpy.props

class _PropDef:
    __slots__ = ("type", "kw")

    def __init__(self, type_, kw):
        self.type, self.kw = type_, kw

    def default(self):
        d = self.kw.get("default")
        if d is not None:
            return d
        return {"FLOAT": 0.0, "INT": 0, "BOOLEAN": False, "STRING": "", "ENUM": None}.get(self.type, (0.0, 0.0, 0.0))

    def spec(self):
        o = {"__kind": "propdef", "type": self.type}
        for k, v in self.kw.items():
            if k in ("update", "get", "set", "poll"):
                continue
            if k == "items":
                if callable(v):
                    raise TypeError("EnumProperty: dynamic items callbacks are not supported")
                v = [list(it)[:3] for it in v]
            if k == "options" or k == "override":
                v = list(v)
            if k == "default" and isinstance(v, set):
                v = sorted(v)[0] if v else None
            o[k] = v
        return o

    def __repr__(self):
        return "<_PropertyDeferred, %sProperty>" % self.type.title()


class _Props:
    @staticmethod
    def FloatProperty(**kw):
        return _PropDef("FLOAT", kw)

    @staticmethod
    def IntProperty(**kw):
        return _PropDef("INT", kw)

    @staticmethod
    def BoolProperty(**kw):
        return _PropDef("BOOLEAN", kw)

    @staticmethod
    def StringProperty(**kw):
        return _PropDef("STRING", kw)

    @staticmethod
    def EnumProperty(**kw):
        return _PropDef("ENUM", kw)

    @staticmethod
    def FloatVectorProperty(**kw):
        return _PropDef("FLOAT_VECTOR", kw)

    @staticmethod
    def IntVectorProperty(**kw):
        return _PropDef("INT_VECTOR", kw)

    @staticmethod
    def BoolVectorProperty(**kw):
        return _PropDef("BOOL_VECTOR", kw)

    @staticmethod
    def PointerProperty(**kw):
        raise TypeError("PointerProperty is not supported by this application")

    @staticmethod
    def CollectionProperty(**kw):
        raise TypeError("CollectionProperty is not supported by this application")


props = _Props()

# ---------------------------------------------------------------------------
# bpy.types

class _TypeMeta(type):
    """`isinstance(ob, bpy.types.Object)` compares the struct type name."""

    def __instancecheck__(cls, obj):
        if isinstance(obj, _Struct):
            t = str(_br.typename(obj._js))
            return t == cls.__name__ or cls.__name__ in ("ID", "bpy_struct") and _br.kind(obj._js) == "id"
        return type.__instancecheck__(cls, obj)


class _Report:
    def report(self, type, message):
        t = next(iter(type)) if isinstance(type, (set, frozenset, list, tuple)) else str(type)
        _br.report("ERROR" if t == "ERROR" else "WARNING" if t == "WARNING" else "INFO", str(message))


class Operator(_Report):
    """Base class for script operators (``bl_idname``, ``bl_label``, ``execute``)."""

    bl_idname = ""
    bl_label = ""
    bl_description = ""
    bl_options = {"REGISTER"}

    @property
    def properties(self):
        return self

    @property
    def layout(self):
        return _Struct(_br.new_layout())

    def as_keywords(self, ignore=()):
        return {k: getattr(self, k) for k in _op_props(type(self)) if k not in ignore}


class Panel:
    """Base class for script panels drawn in the 3D viewport sidebar."""

    bl_idname = ""
    bl_label = ""
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Misc"
    bl_context = ""
    bl_options = set()
    bl_order = 0


class Menu:
    bl_idname = ""
    bl_label = ""


class PropertyGroup:
    pass


class _Types:
    Operator = Operator
    Panel = Panel
    Menu = Menu
    PropertyGroup = PropertyGroup

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        cls = _TypeMeta(name, (), {})
        setattr(self, name, cls)
        return cls


types = _Types()

# ---------------------------------------------------------------------------
# bpy.utils (registration)

def _op_props(cls):
    out = {}
    for klass in reversed(cls.__mro__):
        for k, v in getattr(klass, "__annotations__", {}).items():
            if isinstance(v, _PropDef):
                out[k] = v
        for k, v in vars(klass).items():
            if isinstance(v, _PropDef):
                out[k] = v
    return out


def _result(r):
    if isinstance(r, str):
        return r
    if isinstance(r, (set, frozenset, list, tuple)):
        for k in ("FINISHED", "RUNNING_MODAL", "PASS_THROUGH", "CANCELLED"):
            if k in r:
                return k
    return "FINISHED" if r is None else "CANCELLED"


def _concise(exc):
    return "%s: %s" % (type(exc).__name__, exc)


_registered = {}


class _WindowManager:
    """Subset of context.window_manager used inside operators."""

    def invoke_props_dialog(self, operator, width=300):
        return {_result(operator.execute(context))}

    def invoke_confirm(self, operator, event=None, **kw):
        return {_result(operator.execute(context))}

    def invoke_props_popup(self, operator, event=None):
        return {_result(operator.execute(context))}

    def popup_menu(self, draw_func, title="", icon="NONE"):
        return None


class _Context(_Struct):
    __slots__ = ()

    @property
    def window_manager(self):
        return _WindowManager()

    def temp_override(self, **kw):
        """``with bpy.context.temp_override(active_object=ob, selected_objects=[ob]):``"""
        return _TempOverride(self, kw)


class _TempOverride:
    def __init__(self, ctx, kw):
        self._ctx, self._kw = ctx, kw

    def __enter__(self):
        _call(_br.call, self._ctx._js, "temp_override_begin", _tojs([self._kw]), js.Object.new())
        return self._ctx

    def __exit__(self, *exc):
        _call(_br.call, self._ctx._js, "temp_override_end", js.Array.new(), js.Object.new())
        return False


def _make_instance(cls, values):
    inst = cls.__new__(cls)
    for k, pdef in _op_props(cls).items():
        v = values.get(k, pdef.default()) if values is not None else pdef.default()
        if isinstance(v, list) and pdef.type.endswith("_VECTOR"):
            v = mathutils.Color(v) if pdef.kw.get("subtype", "") in ("COLOR", "COLOR_GAMMA") else mathutils.Vector(v)
        if pdef.type == "ENUM" and "ENUM_FLAG" in pdef.kw.get("options", ()):
            v = {v} if isinstance(v, str) else set(v)
        object.__setattr__(inst, k, v)
    return inst


def _register_operator(cls):
    idname = getattr(cls, "bl_idname", "")
    props = {k: v.spec() for k, v in _op_props(cls).items()}

    def _exec(values):
        try:
            inst = _make_instance(cls, values.to_py() if hasattr(values, "to_py") else dict(values or {}))
            return _result(cls.execute(inst, context))
        except Exception as e:
            import traceback

            traceback.print_exc()
            raise RuntimeError(_concise(e)) from None

    def _invoke(values, event):
        try:
            inst = _make_instance(cls, values.to_py() if hasattr(values, "to_py") else dict(values or {}))
            return _result(cls.invoke(inst, context, _Struct(event)))
        except Exception as e:
            import traceback

            traceback.print_exc()
            raise RuntimeError(_concise(e)) from None

    def _poll():
        try:
            return bool(cls.poll(context))
        except Exception:
            return False

    proxies = [create_proxy(_exec)]
    spec = {
        "idname": idname,
        "label": getattr(cls, "bl_label", "") or cls.__name__,
        "description": getattr(cls, "bl_description", "") or (cls.__doc__ or "").strip(),
        "options": sorted(getattr(cls, "bl_options", {"REGISTER"})),
        "props": props,
        "language": "python",
    }
    jspec = _tojs(spec)
    js.Reflect.set(jspec, "exec", proxies[0])
    if hasattr(cls, "poll"):
        p = create_proxy(_poll)
        proxies.append(p)
        js.Reflect.set(jspec, "poll", p)
    if hasattr(cls, "invoke"):
        p = create_proxy(_invoke)
        proxies.append(p)
        js.Reflect.set(jspec, "invoke", p)
    _call(_br.register_operator, jspec)
    _registered[cls] = ("op", idname, proxies)


def _register_panel(cls):
    idname = getattr(cls, "bl_idname", "") or cls.__name__

    def _draw(layout):
        inst = cls.__new__(cls)
        object.__setattr__(inst, "layout", _Struct(layout))
        cls.draw(inst, context)

    def _poll():
        try:
            return bool(cls.poll(context))
        except Exception:
            return False

    proxies = [create_proxy(_draw)]
    opts = getattr(cls, "bl_options", set())
    spec = _tojs({
        "idname": idname,
        "label": getattr(cls, "bl_label", "") or cls.__name__,
        "space": getattr(cls, "bl_space_type", "VIEW_3D"),
        "region": getattr(cls, "bl_region_type", "UI"),
        "category": getattr(cls, "bl_category", "") or "Misc",
        "order": int(getattr(cls, "bl_order", 0)),
        "defaultClosed": "DEFAULT_CLOSED" in opts,
        "hideHeader": "HIDE_HEADER" in opts,
        "language": "python",
    })
    js.Reflect.set(spec, "draw", proxies[0])
    if hasattr(cls, "poll"):
        p = create_proxy(_poll)
        proxies.append(p)
        js.Reflect.set(spec, "poll", p)
    _call(_br.register_panel, spec)
    _registered[cls] = ("panel", idname, proxies)


def _release(entry):
    for p in entry[2]:
        try:
            p.destroy()
        except Exception:
            pass


class _Utils:
    @staticmethod
    def register_class(cls):
        if cls in _registered:
            raise ValueError("register_class(...): already registered as a subclass '%s'" % cls.__name__)
        # re-registering a class with the same idname (e.g. running a script twice) replaces it
        for old, entry in list(_registered.items()):
            if entry[1] == (getattr(cls, "bl_idname", "") or cls.__name__):
                _Utils.unregister_class(old)
        if issubclass(cls, Operator):
            if not hasattr(cls, "execute") and not hasattr(cls, "invoke"):
                raise TypeError("register_class(...): operator '%s' needs an execute() method" % cls.__name__)
            _register_operator(cls)
        elif issubclass(cls, Panel):
            if not hasattr(cls, "draw"):
                raise TypeError("register_class(...): panel '%s' needs a draw() method" % cls.__name__)
            _register_panel(cls)
        elif issubclass(cls, (Menu, PropertyGroup)):
            raise TypeError("register_class(...): %s subclasses are not supported by this application" % cls.__mro__[1].__name__)
        else:
            raise TypeError("register_class(...): expected a subclass of bpy.types.Operator or bpy.types.Panel")

    @staticmethod
    def unregister_class(cls):
        entry = _registered.pop(cls, None)
        if entry is None:
            raise RuntimeError("unregister_class(...): missing bl_rna attribute from '%s' instance (may not be registered)" % cls.__name__)
        if entry[0] == "op":
            _br.unregister_operator(entry[1])
        else:
            _br.unregister_panel(entry[1])
        _release(entry)

    @staticmethod
    def register_classes_factory(classes):
        def register():
            for c in classes:
                _Utils.register_class(c)

        def unregister():
            for c in reversed(classes):
                _Utils.unregister_class(c)

        return register, unregister

    @staticmethod
    def user_resource(resource_type, path="", create=False):
        return "/home/pyodide/" + path

    @staticmethod
    def script_paths():
        return ["/home/pyodide/p3d"]


utils = _Utils()

# ---------------------------------------------------------------------------
# roots

data = _wrap(_br.root("data"))
context = _Context(_br.root("context"))


# ---------------------------------------------------------------------------
# bpy.app.handlers / bpy.app.timers (Python functions stay on the Python side)

_HANDLER_NAMES = (
    "frame_change_pre", "frame_change_post", "depsgraph_update_pre", "depsgraph_update_post",
    "load_pre", "load_post", "load_factory_startup_post", "save_pre", "save_post",
    "render_init", "render_pre", "render_post", "render_write", "render_complete", "render_cancel",
    "undo_pre", "undo_post", "redo_pre", "redo_post", "animation_playback_pre", "animation_playback_post",
)


def _arg_count(fn):
    """How many positional arguments a handler takes (2 when it takes *args)."""
    import inspect

    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return 2
    n = 0
    for p in params:
        if p.kind == p.VAR_POSITIONAL:
            return 2
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) and p.default is p.empty:
            n += 1
    return n


class _Handlers:
    """Lists of functions called on events; ``persistent`` keeps one across file loads."""

    def __init__(self):
        for n in _HANDLER_NAMES:
            setattr(self, n, [])

    @staticmethod
    def persistent(fn):
        fn._bpy_persistent = True
        return fn

    def __repr__(self):
        return "<bpy.app.handlers>"


handlers = _Handlers()


def _handler_count(name):
    return len(getattr(handlers, name, ()))


def _handler_dispatch(name, arg=None):
    if name == "__clear_nonpersistent__":
        for n in _HANDLER_NAMES:
            lst = getattr(handlers, n)
            lst[:] = [f for f in lst if getattr(f, "_bpy_persistent", False)]
        return 0
    lst = list(getattr(handlers, name, ()))
    if not lst:
        return 0
    first = context.scene if _is_null(arg) else arg
    depsgraph = None
    for fn in lst:
        try:
            n = _arg_count(fn)
            if n >= 2:
                if depsgraph is None:
                    depsgraph = context.evaluated_depsgraph_get()
                fn(first, depsgraph)
            elif n == 1:
                fn(first)
            else:
                fn()
        except Exception:
            import traceback

            sys.stderr.write("Error in %s handler %s:\n" % (name, getattr(fn, "__name__", "?")))
            traceback.print_exc()
    return len(lst)


_handler_proxies = (create_proxy(_handler_dispatch), create_proxy(_handler_count))
_br.set_handlers(*_handler_proxies)


class _Timers:
    """Functions run after a delay, then again after the number of seconds they return (None stops)."""

    def __init__(self):
        self._ids = {}

    def register(self, function, first_interval=0, persistent=False):
        if self.is_registered(function):
            raise ValueError("bpy.app.timers.register(): function is already registered")

        def tick():
            try:
                r = function()
            except Exception:
                import traceback

                traceback.print_exc()
                r = None
            if r is None:
                self._ids.pop(function, None)
                return -1
            return float(r)

        self._ids[function] = _br.timer_add(create_proxy(tick), float(first_interval), bool(persistent))

    def unregister(self, function):
        i = self._ids.pop(function, None)
        if i is None:
            raise ValueError("Error: function is not registered as a timer")
        _br.timer_remove(i)

    def is_registered(self, function):
        i = self._ids.get(function)
        return i is not None and bool(_br.timer_active(i))

    def __repr__(self):
        return "<bpy.app.timers>"


timers = _Timers()


class _App(_Struct):
    __slots__ = ()
    handlers = handlers
    timers = timers

    @property
    def driver_namespace(self):
        return _driver_namespace


_driver_namespace = {}
app = _App(_br.root("app"))


class _Path:
    @staticmethod
    def abspath(p, start=None, library=None):
        return p

    @staticmethod
    def basename(p):
        return p.replace("\\", "/").rsplit("/", 1)[-1]

    @staticmethod
    def display_name(name, has_ext=True):
        if has_ext and "." in name:
            name = name.rsplit(".", 1)[0]
        return name.replace("_", " ").title()

    @staticmethod
    def clean_name(name, replace="_"):
        return "".join(c if c.isalnum() else replace for c in name)

    @staticmethod
    def ensure_ext(filepath, ext, case_sensitive=False):
        return filepath if filepath.lower().endswith(ext.lower()) else filepath + ext


path = _Path()


# `from bpy.types import Operator`, `from bpy.props import FloatProperty`, `from bpy.app.handlers import persistent`
for _name, _mod in (("types", types), ("props", props), ("utils", utils), ("ops", ops), ("path", path), ("app", app), ("app.handlers", handlers), ("app.timers", timers)):
    sys.modules["bpy." + _name] = _mod
