package cn.lingshi.familytree;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
@MapperScan("cn.lingshi.familytree.mapper")
public class FamilyTreeBackendApplication {

	public static void main(String[] args) {
		SpringApplication.run(FamilyTreeBackendApplication.class, args);
	}

}
