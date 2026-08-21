export interface DeclarationTrie {
	readonly ignored: boolean;
	readonly unsafe: boolean;
	readonly children: ReadonlyMap<string, DeclarationTrie>;
}

export interface MutableDeclarationTrie {
	ignored: boolean;
	unsafe: boolean;
	children: Map<string, MutableDeclarationTrie>;
}

export function createDeclarationTrie(): MutableDeclarationTrie {
	return { ignored: false, unsafe: false, children: new Map() };
}

export function declarationChild(trie: DeclarationTrie | undefined, key: string | number): DeclarationTrie | undefined {
	return trie?.children.get(String(key));
}

function ensureDeclarationChild(trie: MutableDeclarationTrie, key: string | number): MutableDeclarationTrie {
	const name = String(key);
	const existing = trie.children.get(name);

	if (existing !== undefined) return existing;

	const child = createDeclarationTrie();

	trie.children.set(name, child);

	return child;
}

export function declarationAtPath(
	trie: MutableDeclarationTrie,
	path: ReadonlyArray<string | number>,
): MutableDeclarationTrie {
	let current = trie;

	for (const segment of path) current = ensureDeclarationChild(current, segment);

	return current;
}

export function graftDeclarationChildren(source: MutableDeclarationTrie, target: MutableDeclarationTrie): void {
	for (const [key, sourceChild] of source.children) {
		const targetChild = ensureDeclarationChild(target, key);

		if (sourceChild.ignored) targetChild.ignored = true;

		if (sourceChild.unsafe) targetChild.unsafe = true;

		graftDeclarationChildren(sourceChild, targetChild);
	}
}

export function hasDeclarations(trie: MutableDeclarationTrie): boolean {
	if (trie.ignored || trie.unsafe) return true;

	for (const child of trie.children.values()) {
		if (hasDeclarations(child)) return true;
	}

	return false;
}
