import "@fastify/jwt";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: any;
  }
  interface FastifyRequest {
    user: { id: string; stellar_address: string };
  }
}
