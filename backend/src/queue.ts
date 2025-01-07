export class Queue<T> {
    private queue: T[] = [];

    /**
     * Add an item to the end of the queue.
     * @param item the item to add
     */
    public offer(item: T) {
        this.queue.push(item);
    }

    /**
     * Remove and return the first item in the queue.
     */
    public poll(): T | undefined {
        return this.queue.shift();
    }

    /**
     * Return the first item in the queue without removing it.
     */
    public peek(): T | undefined {
        return this.queue[0];
    }

    /**
     * Return the number of items in the queue.
     */
    public size(): number {
        return this.queue.length;
    }

    /**
     * Return whether the queue is empty.
     */
    public isEmpty(): boolean {
        return this.queue.length === 0;
    }

    /**
     * Return whether the queue is not empty.
     *
     * This is equivalent to `!isEmpty()`.
     *
     * @example
     * ```typescript
     * // Process all items in the queue
     * while (queue.isNotEmpty()) {
     *   const item = queue.poll();
     *   // process item
     * }
     * ```
     */
    public isNotEmpty(): boolean {
        return this.queue.length > 0;
    }
}
