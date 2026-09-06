export type FamilyPerson = { id: string };
export type FamilyRelationship = {
  from_person_id: string;
  to_person_id: string;
  type: 'PARENT' | 'CHILD' | 'SPOUSE';
};

export function calculateGenerations(
  people: FamilyPerson[],
  relationships: FamilyRelationship[],
) {
  const ids = new Set(people.map((person) => person.id));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(right, left);
  };
  people.forEach(({ id }) => parent.set(id, id));
  relationships
    .filter((item) => item.type === 'SPOUSE' && ids.has(item.from_person_id) && ids.has(item.to_person_id))
    .forEach((item) => union(item.from_person_id, item.to_person_id));

  const edges = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  const components = new Set(people.map(({ id }) => find(id)));
  components.forEach((id) => incoming.set(id, 0));
  relationships.forEach((item) => {
    let source = item.from_person_id;
    let target = item.to_person_id;
    if (item.type === 'CHILD') [source, target] = [target, source];
    if (item.type === 'SPOUSE' || !ids.has(source) || !ids.has(target)) return;
    const from = find(source);
    const to = find(target);
    if (from === to) return;
    const children = edges.get(from) ?? new Set<string>();
    if (!children.has(to)) {
      children.add(to);
      edges.set(from, children);
      incoming.set(to, (incoming.get(to) ?? 0) + 1);
    }
  });

  const generation = new Map<string, number>();
  const queue = [...components].filter((id) => (incoming.get(id) ?? 0) === 0);
  queue.forEach((id) => generation.set(id, 1));
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of edges.get(current) ?? []) {
      generation.set(child, Math.max(generation.get(child) ?? 1, (generation.get(current) ?? 1) + 1));
      incoming.set(child, (incoming.get(child) ?? 1) - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  components.forEach((id) => {
    if (!generation.has(id)) generation.set(id, 1);
  });
  return new Map(people.map(({ id }) => [id, generation.get(find(id)) ?? 1]));
}
