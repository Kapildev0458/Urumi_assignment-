// The MCP tools. Each one maps to a WooCommerce REST call and returns a compact JSON summary
// (full WooCommerce objects are huge and waste model context).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveDay } from './dates.js';
import { WooClient, WooError } from './woo.js';

const ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const;

interface WooProduct {
  id: number;
  name: string;
  sku: string;
  status: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_status: string;
  stock_quantity: number | null;
  permalink: string;
  date_created: string;
}

interface WooLineItem {
  product_id: number;
  name: string;
  quantity: number;
  total: string;
}

interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created: string;
  payment_method_title: string;
  customer_note: string;
  billing: { first_name: string; last_name: string; email: string; phone: string };
  line_items: WooLineItem[];
}

const product = (p: WooProduct) => ({
  id: p.id,
  name: p.name,
  sku: p.sku || undefined,
  status: p.status,
  price: p.price,
  regular_price: p.regular_price,
  sale_price: p.sale_price || undefined,
  stock_status: p.stock_status,
  stock_quantity: p.stock_quantity ?? undefined,
  url: p.permalink,
  created: p.date_created,
});

const orderSummary = (o: WooOrder) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: `${o.total} ${o.currency}`,
  created: o.date_created,
  customer: `${o.billing.first_name} ${o.billing.last_name}`.trim() || o.billing.email || 'guest',
  items: o.line_items.map((li) => `${li.quantity} x ${li.name}`),
});

const orderDetail = (o: WooOrder) => ({
  ...orderSummary(o),
  payment_method: o.payment_method_title,
  customer_note: o.customer_note || undefined,
  billing: o.billing,
  line_items: o.line_items.map((li) => ({
    product_id: li.product_id,
    name: li.name,
    quantity: li.quantity,
    total: li.total,
  })),
});

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Wraps a handler so store errors become MCP tool errors (isError) instead of protocol errors. */
function safe<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      const message = err instanceof WooError || err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  };
}

const page = {
  per_page: z.number().int().min(1).max(100).default(20).describe('Results per page (max 100)'),
  page: z.number().int().min(1).default(1).describe('Page number, starting at 1'),
};

export function registerTools(server: McpServer, woo: WooClient): void {
  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description: 'List or search products in the WooCommerce store, newest first.',
      inputSchema: {
        search: z.string().optional().describe('Text to search for in product names/descriptions'),
        status: z
          .enum(['any', 'publish', 'draft', 'pending', 'private'])
          .default('any')
          .describe('Product status filter'),
        ...page,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ search, status, per_page, page }) => {
      const products = await woo.get<WooProduct[]>('products', {
        search,
        status,
        per_page,
        page,
        orderby: 'date',
        order: 'desc',
      });
      return { count: products.length, products: products.map(product) };
    }),
  );

  server.registerTool(
    'create_product',
    {
      title: 'Create product',
      description:
        'Create a simple product. It is published to the storefront immediately unless status is "draft".',
      inputSchema: {
        name: z.string().min(1).describe('Product name'),
        regular_price: z
          .union([z.string(), z.number()])
          .transform(String)
          .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), 'Price must be a number like 19.99')
          .describe('Price in the store currency, e.g. "19.99"'),
        description: z.string().optional().describe('Long description (HTML allowed)'),
        short_description: z.string().optional(),
        sku: z.string().optional(),
        stock_quantity: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Enables stock management with this quantity'),
        status: z.enum(['publish', 'draft']).default('publish'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    safe(async ({ stock_quantity, ...fields }) => {
      const created = await woo.post<WooProduct>('products', {
        type: 'simple',
        ...fields,
        ...(stock_quantity === undefined ? {} : { manage_stock: true, stock_quantity }),
      });
      return { created: product(created) };
    }),
  );

  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description:
        'List orders, newest first. Use `date` for a single day in the store timezone ' +
        '("today", "yesterday" or YYYY-MM-DD), or after/before for a custom range.',
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('"today", "yesterday" or YYYY-MM-DD (store timezone)'),
        after: z.string().optional().describe('ISO 8601 date-time, orders created after it'),
        before: z.string().optional().describe('ISO 8601 date-time, orders created before it'),
        status: z.enum(['any', ...ORDER_STATUSES]).default('any'),
        search: z.string().optional().describe('Search by customer name, email, etc.'),
        ...page,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ date, after, before, status, search, per_page, page }) => {
      let range: { after?: string; before?: string; day?: string } = { after, before };
      if (date) range = resolveDay(date, await woo.storeGmtOffset());
      const orders = await woo.get<WooOrder[]>('orders', {
        after: range.after,
        before: range.before,
        status,
        search,
        per_page,
        page,
        orderby: 'date',
        order: 'desc',
      });
      return {
        ...(range.day ? { day: range.day } : {}),
        count: orders.length,
        orders: orders.map(orderSummary),
      };
    }),
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description: 'Get one order with customer, payment and line item details.',
      inputSchema: { id: z.number().int().positive().describe('Order ID') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ id }) => orderDetail(await woo.get<WooOrder>(`orders/${id}`))),
  );

  server.registerTool(
    'update_order_status',
    {
      title: 'Update order status',
      description: 'Change the status of an order, optionally adding a private order note.',
      inputSchema: {
        id: z.number().int().positive().describe('Order ID'),
        status: z.enum(ORDER_STATUSES),
        note: z.string().optional().describe('Private note added to the order'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    safe(async ({ id, status, note }) => {
      const updated = await woo.put<WooOrder>(`orders/${id}`, { status });
      if (note) await woo.post(`orders/${id}/notes`, { note, customer_note: false });
      return { updated: orderSummary(updated) };
    }),
  );
}
