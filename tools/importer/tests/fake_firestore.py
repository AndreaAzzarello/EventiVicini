"""Firestore finto, quanto basta per l'importer e la pulizia: where/select/stream/count/get_all/batch.

Conta letture e scritture come la quota Spark: 1 lettura per documento restituito, 1 scrittura per set/update/delete.
"""

from __future__ import annotations

from types import SimpleNamespace

from google.api_core.exceptions import NotFound


class Doc:
    def __init__(self, fs, path, data):
        self.id, self.reference, self._data = path.split("/")[-1], Ref(fs, path), data

    exists = property(lambda self: self._data is not None)

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class Ref:
    def __init__(self, fs, path):
        self.fs, self.path = fs, path

    id = property(lambda self: self.path.split("/")[-1])


class Query:
    def __init__(self, fs, coll, filters=(), fields=None):
        self.fs, self.coll, self.filters, self.fields = fs, coll, tuple(filters), fields

    def where(self, *, filter):  # noqa: A002
        return Query(self.fs, self.coll, self.filters + ((filter.field_path, filter.op_string, filter.value),), self.fields)

    def select(self, fields):
        return Query(self.fs, self.coll, self.filters, list(fields))

    def _match(self, d):
        for f, op, v in self.filters:
            x = d.get(f)
            ok = {"==": lambda: x == v, "<": lambda: x is not None and x < v, "<=": lambda: x is not None and x <= v,
                  ">=": lambda: x is not None and x >= v, ">": lambda: x is not None and x > v,
                  "in": lambda: x in v}[op]()
            if not ok:
                return False
        return True

    def stream(self):
        out = []
        for path, d in sorted(self.fs.data.items()):
            if path.startswith(self.coll + "/") and self._match(d):
                self.fs.reads += 1
                out.append(Doc(self.fs, path, {k: d[k] for k in self.fields if k in d} if self.fields else d))
        return iter(out)

    def count(self):
        n = sum(1 for p, d in self.fs.data.items() if p.startswith(self.coll + "/") and self._match(d))
        self.fs.reads += max(1, -(-n // 1000))
        return SimpleNamespace(get=lambda: [[SimpleNamespace(value=n)]])


class Batch:
    def __init__(self, fs):
        self.fs, self.ops = fs, []

    def set(self, ref, data, merge=False):
        self.ops.append(("merge" if merge else "set", ref.path, data))

    def update(self, ref, data):
        self.ops.append(("update", ref.path, data))

    def delete(self, ref):
        self.ops.append(("delete", ref.path, None))

    def commit(self):
        assert len(self.ops) <= 500, "oltre 500 operazioni per batch"
        for kind, path, data in self.ops:
            self.fs.writes += 1
            if kind == "set":
                self.fs.data[path] = dict(data)
            elif kind == "merge":
                self.fs.data.setdefault(path, {}).update(data)
            elif kind == "update":
                if path not in self.fs.data:
                    raise NotFound(path)  # come Firestore: update di un documento che non esiste
                self.fs.data[path].update(data)
            else:
                self.fs.data.pop(path, None)
        self.fs.commits += 1


class Collection(Query):
    def document(self, doc_id):
        return Ref(self.fs, f"{self.coll}/{doc_id}")


class FakeFirestore:
    def __init__(self, data: dict[str, dict] | None = None):
        self.data = dict(data or {})  # "events/abc" → campi
        self.reads = self.writes = self.commits = 0

    def collection(self, name):
        return Collection(self, name)

    def batch(self):
        return Batch(self)

    def get_all(self, refs, field_paths=None):
        out = []
        for r in refs:
            self.reads += 1
            d = self.data.get(r.path)
            out.append(Doc(self, r.path, None if d is None else {k: d[k] for k in (field_paths or d) if k in d}))
        return out
