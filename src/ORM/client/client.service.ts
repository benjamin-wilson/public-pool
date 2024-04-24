import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { ObjectLiteral, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';

@Injectable()
export class ClientService {
  public insertQueue: {
    result: BehaviorSubject<ObjectLiteral | null>;
    partialClient: Partial<ClientEntity>;
  }[] = [];

  constructor(
    @InjectRepository(ClientEntity)
    private clientRepository: Repository<ClientEntity>,
  ) {}

  @Interval(1000 * 5)
  public async insertClients() {
    const queueCopy = [...this.insertQueue];
    this.insertQueue = [];

    const results = await this.clientRepository.insert(
      queueCopy.map((c) => c.partialClient),
    );

    queueCopy.forEach((c, index) => {
      c.result.next(results.generatedMaps[index]);
    });
  }

  public async killDeadClients() {
    const fiveMinutes = new Date(
      new Date().getTime() - 5 * 60 * 1000,
    ).toISOString();

    return await this.clientRepository
      .createQueryBuilder()
      .update(ClientEntity)
      .set({ deletedAt: () => "DATETIME('now')" })
      .where('deletedAt IS NULL AND updatedAt < DATETIME(:fiveMinutes)', {
        fiveMinutes,
      })
      .execute();
  }

  public async heartbeat(
    address: string,
    clientName: string,
    sessionId: string,
    hashRate: number,
    updatedAt: Date,
  ) {
    return await this.clientRepository.update(
      { address, clientName, sessionId },
      { hashRate, deletedAt: null, updatedAt },
    );
  }

  // public async save(client: Partial<ClientEntity>) {
  //     return await this.clientRepository.save(client);
  // }

  public async insert(
    partialClient: Partial<ClientEntity>,
  ): Promise<ClientEntity> {
    const result = new BehaviorSubject(null);

    this.insertQueue.push({ result, partialClient });

    //  const insertResult = await this.clientRepository.insert(partialClient);

    const generatedMap = await firstValueFrom(result);

    const client = {
      ...partialClient,
      ...generatedMap,
    };

    return client as ClientEntity;
  }

  public async delete(sessionId: string) {
    return await this.clientRepository.softDelete({ sessionId });
  }

  public async deleteOldClients() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return await this.clientRepository
      .createQueryBuilder()
      .delete()
      .from(ClientEntity)
      .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
      .execute();
  }

  public async updateBestDifficulty(sessionId: string, bestDifficulty: number) {
    return await this.clientRepository.update(
      { sessionId },
      { bestDifficulty },
    );
  }
  public async connectedClientCount(): Promise<number> {
    return await this.clientRepository.count();
  }

  public async getByAddress(address: string): Promise<ClientEntity[]> {
    return await this.clientRepository.find({
      where: {
        address,
      },
    });
  }

  public async getByName(
    address: string,
    clientName: string,
  ): Promise<ClientEntity[]> {
    return await this.clientRepository.find({
      where: {
        address,
        clientName,
      },
    });
  }

  public async getBySessionId(
    address: string,
    clientName: string,
    sessionId: string,
  ): Promise<ClientEntity> {
    return await this.clientRepository.findOne({
      where: {
        address,
        clientName,
        sessionId,
      },
    });
  }

  public async deleteAll() {
    return await this.clientRepository.softDelete({});
  }

  public async getUserAgents() {
    const result = await this.clientRepository
      .createQueryBuilder('client')
      .select('client.userAgent as userAgent')
      .addSelect('COUNT(client.userAgent)', 'count')
      .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
      .addSelect('SUM(client.hashRate)', 'totalHashRate')
      .groupBy('client.userAgent')
      .orderBy('count', 'DESC')
      .getRawMany();
    return result;
  }
}
