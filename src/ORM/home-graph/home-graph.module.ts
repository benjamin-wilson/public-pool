import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { HomeGraphEntity } from './home-graph.entity';
import { HomeGraphService } from './home-graph.service';



@Global()
@Module({
    imports: [TypeOrmModule.forFeature([HomeGraphEntity])],
    providers: [HomeGraphService],
    exports: [TypeOrmModule, HomeGraphService],
})
export class HomeGraphModule { }